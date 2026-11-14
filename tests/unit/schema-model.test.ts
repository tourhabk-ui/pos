/**
 * Модель схемы: разбор команд SQL, из которых объектив эволюции выводит
 * «какие колонки и ключи есть в базе».
 *
 * Повод — #3343 (до него #2891 и #3268): три «критические» задачи
 * «обращение к несуществующей колонке» о рабочем коде. Причина одна: таблицу
 * переписки миграция 1350 переименовала, а модель переименования не понимала.
 * Замер 14.11: 119 находок объектива, из них 101 — от переименования, 12 —
 * от внешних ключей, объявленных рядом с колонкой, 4 — от колонок без таблицы
 * в куске запроса и поверх подзапроса. Настоящих — 2, обе об одной колонке.
 *
 * Здесь разбор судится вызовом на коротких командах и на самом репозитории.
 * Сверку модели с настоящей базой держит
 * tests/integration/schema-model.pg.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  absorbSql, loadSchemaModel, stripSqlComments, type SchemaModel,
} from '@/lib/agents/evo/schema-model';
import { scanSourceAgainstSchema } from '@/lib/agents/evo/schema-lens';
import { listRepoFiles } from '@/lib/agents/evo/repo-files';

function empty(): SchemaModel {
  return { columns: new Map(), foreignKeys: new Map(), views: new Set() };
}

function modelOf(...files: string[]): SchemaModel {
  const m = empty();
  for (const f of files) absorbSql(f, m);
  return m;
}

const cols = (m: SchemaModel, t: string) => [...(m.columns.get(t) ?? [])].sort();
const fk = (m: SchemaModel, key: string) => {
  const f = m.foreignKeys.get(key);
  return f ? `${f.refTable}.${f.refColumn}` : null;
};

const CHAT_1349 = `
CREATE TABLE IF NOT EXISTS stay_request_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stay_request_id  UUID NOT NULL REFERENCES stay_requests(id) ON DELETE CASCADE,
  author           TEXT NOT NULL,
  body             TEXT NOT NULL,
  CONSTRAINT stay_request_messages_author_check CHECK (author IN ('owner', 'guest'))
);`;

/** Форма миграции 1350: переименование в DO-блоке, колонка под новым именем, откат в комментарии. */
const CHAT_1350 = `
DO $$
BEGIN
  IF to_regclass('public.stay_request_messages') IS NOT NULL
     AND to_regclass('public.request_messages') IS NULL THEN
    ALTER TABLE stay_request_messages RENAME TO request_messages;
  END IF;
END $$;

ALTER TABLE request_messages ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE CASCADE;

CREATE OR REPLACE VIEW stay_request_messages AS
  SELECT * FROM request_messages WHERE stay_request_id IS NOT NULL;

-- Rollback:
-- ALTER TABLE request_messages DROP COLUMN IF EXISTS lead_id;
-- ALTER TABLE request_messages RENAME TO stay_request_messages;
`;

describe('переименование таблицы', () => {
  it('колонки старого имени переходят новому вместе с дописанной позже', () => {
    const m = modelOf(CHAT_1349, CHAT_1350);
    expect(cols(m, 'request_messages')).toEqual(['author', 'body', 'id', 'lead_id', 'stay_request_id']);
  });

  it('под старым именем таблицы больше нет', () => {
    const m = modelOf(CHAT_1349, CHAT_1350);
    expect(m.columns.has('stay_request_messages')).toBe(false);
    expect(m.views.has('stay_request_messages')).toBe(true);
  });

  it('откат в комментарии таблицу обратно не переименовывает и колонку не снимает', () => {
    const m = modelOf(CHAT_1349, CHAT_1350);
    expect(m.columns.has('request_messages')).toBe(true);
    expect(m.columns.get('request_messages')?.has('lead_id')).toBe(true);
  });

  it('ключи таблицы переезжают под новое имя — и её собственные, и ведущие в неё', () => {
    const m = modelOf(
      CHAT_1349,
      'CREATE TABLE notes (\n  id UUID PRIMARY KEY,\n  message_id UUID REFERENCES stay_request_messages(id)\n);',
      CHAT_1350,
    );
    expect(fk(m, 'request_messages.stay_request_id')).toBe('stay_requests.id');
    expect(fk(m, 'stay_request_messages.stay_request_id')).toBeNull();
    expect(fk(m, 'notes.message_id')).toBe('request_messages.id');
    expect(fk(m, 'request_messages.lead_id')).toBe('leads.id');
  });

  it('колонка, дописанная новому имени ВЫШЕ переименования, не теряется', () => {
    const m = modelOf(
      CHAT_1349,
      'ALTER TABLE request_messages ADD COLUMN IF NOT EXISTS translation TEXT;\nALTER TABLE stay_request_messages RENAME TO request_messages;',
    );
    expect(cols(m, 'request_messages')).toEqual(['author', 'body', 'id', 'stay_request_id', 'translation']);
  });

  it('запись в несколько строк и с IF EXISTS читается так же (миграция 688)', () => {
    const m = modelOf(
      'CREATE TABLE route_description_cache (\n  id UUID PRIMARY KEY,\n  route_id UUID\n);',
      'ALTER TABLE IF EXISTS route_description_cache\n  RENAME TO _route_description_cache_legacy;\n\nCREATE TABLE IF NOT EXISTS route_description_cache (\n  route_id INTEGER PRIMARY KEY,\n  description TEXT NOT NULL\n);',
    );
    expect(cols(m, '_route_description_cache_legacy')).toEqual(['id', 'route_id']);
    expect(cols(m, 'route_description_cache')).toEqual(['description', 'route_id']);
  });

  it('переименование ограничения и индекса таблицу не трогает', () => {
    const m = modelOf(
      CHAT_1349,
      'ALTER TABLE stay_request_messages RENAME CONSTRAINT stay_request_messages_author_check TO author_check;\nALTER INDEX some_idx RENAME TO request_messages;',
    );
    expect(m.columns.has('stay_request_messages')).toBe(true);
    expect(m.columns.has('request_messages')).toBe(false);
    expect(cols(m, 'stay_request_messages')).toEqual(['author', 'body', 'id', 'stay_request_id']);
  });
});

describe('переименование и удаление колонки', () => {
  const GEAR = 'CREATE TABLE gear_availability (\n  id UUID PRIMARY KEY,\n  gear_id UUID REFERENCES gear_items(id),\n  date DATE NOT NULL\n);';

  it('RENAME COLUMN: старого имени нет, новое есть, ключ переехал', () => {
    const m = modelOf(GEAR, 'ALTER TABLE gear_availability RENAME COLUMN gear_id TO gear_item_id;');
    expect(cols(m, 'gear_availability')).toEqual(['date', 'gear_item_id', 'id']);
    expect(fk(m, 'gear_availability.gear_item_id')).toBe('gear_items.id');
    expect(fk(m, 'gear_availability.gear_id')).toBeNull();
  });

  it('слово COLUMN необязательно', () => {
    const m = modelOf(GEAR, 'ALTER TABLE gear_availability RENAME gear_id TO gear_item_id;');
    expect(cols(m, 'gear_availability')).toEqual(['date', 'gear_item_id', 'id']);
  });

  it('ключ, который вёл в переименованную колонку, ведёт в новое имя', () => {
    const m = modelOf(
      'CREATE TABLE gear_items (\n  code TEXT PRIMARY KEY\n);',
      'CREATE TABLE rentals (\n  id UUID PRIMARY KEY,\n  item TEXT REFERENCES gear_items(code)\n);',
      'ALTER TABLE gear_items RENAME COLUMN code TO sku;',
    );
    expect(fk(m, 'rentals.item')).toBe('gear_items.sku');
  });

  it('DROP COLUMN: колонка и её ключ больше не известны (миграция 1021)', () => {
    const m = modelOf(
      'CREATE TABLE guide_schedule (\n  id UUID PRIMARY KEY,\n  tour_id UUID REFERENCES tours(id),\n  booking_id UUID\n);',
      'ALTER TABLE guide_schedule DROP COLUMN IF EXISTS tour_id;\nALTER TABLE guide_schedule DROP COLUMN booking_id;',
    );
    expect(cols(m, 'guide_schedule')).toEqual(['id']);
    expect(fk(m, 'guide_schedule.tour_id')).toBeNull();
  });
});

describe('внешний ключ читается в любой записи', () => {
  it('строкой колонки в CREATE TABLE', () => {
    const m = modelOf('CREATE TABLE mchs_letters (\n  id UUID PRIMARY KEY,\n  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,\n  sent_at TIMESTAMPTZ\n);');
    expect(fk(m, 'mchs_letters.partner_id')).toBe('partners.id');
    expect(fk(m, 'mchs_letters.sent_at')).toBeNull();
  });

  it('строкой таблицы — с именем ограничения и без', () => {
    const m = modelOf('CREATE TABLE t (\n  a UUID,\n  b UUID,\n  CONSTRAINT t_a_fk FOREIGN KEY (a) REFERENCES users(id),\n  FOREIGN KEY (b) REFERENCES public.partners (id) ON DELETE SET NULL\n);');
    expect(fk(m, 't.a')).toBe('users.id');
    expect(fk(m, 't.b')).toBe('partners.id');
    expect(cols(m, 't')).toEqual(['a', 'b']);
  });

  it('в объявлении дописанной колонки — у каждой из нескольких в одной команде', () => {
    const m = modelOf(
      'CREATE TABLE operator_bookings (\n  id BIGINT PRIMARY KEY\n);',
      'ALTER TABLE operator_bookings\n  ADD COLUMN IF NOT EXISTS agent_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,\n  ADD COLUMN IF NOT EXISTS note TEXT,\n  ADD COLUMN IF NOT EXISTS guide_partner_id UUID REFERENCES partners(id);',
    );
    expect(fk(m, 'operator_bookings.agent_user_id')).toBe('users.id');
    expect(fk(m, 'operator_bookings.guide_partner_id')).toBe('partners.id');
    expect(fk(m, 'operator_bookings.note')).toBeNull();
    expect(cols(m, 'operator_bookings')).toEqual(['agent_user_id', 'guide_partner_id', 'id', 'note']);
  });

  it('отдельной командой — форма baseline', () => {
    const m = modelOf(
      'CREATE TABLE operator_tours (\n  id BIGINT PRIMARY KEY,\n  operator_id UUID\n);',
      'ALTER TABLE ONLY public.operator_tours\n    ADD CONSTRAINT operator_tours_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.partners(id) ON DELETE CASCADE;',
    );
    expect(fk(m, 'operator_tours.operator_id')).toBe('partners.id');
  });

  it('повторное объявление существующей таблицы её ключ не переписывает', () => {
    // `CREATE TABLE IF NOT EXISTS` у существующей таблицы на сервере ничего не
    // делает. Прочитанный как действие, ключ из миграции 070 затёр бы ключ
    // baseline: agent_route_knowledge(id) вместо places(ark_id).
    const m = modelOf(
      'CREATE TABLE location_safety_profile (\n  id UUID PRIMARY KEY,\n  agent_route_id UUID\n);\nALTER TABLE location_safety_profile ADD CONSTRAINT fk_lsp_place FOREIGN KEY (agent_route_id) REFERENCES places(ark_id) ON DELETE CASCADE;',
      'CREATE TABLE IF NOT EXISTS location_safety_profile (\n  id UUID PRIMARY KEY,\n  agent_route_id UUID REFERENCES agent_route_knowledge(id) UNIQUE,\n  hazard_types TEXT[]\n);',
    );
    expect(fk(m, 'location_safety_profile.agent_route_id')).toBe('places.ark_id');
    // Колонки при этом объединяются: лишняя известная — молчание объектива.
    expect(m.columns.get('location_safety_profile')?.has('hazard_types')).toBe(true);
  });

  it('повторное объявление существующей колонки её ключ не переписывает, новой — задаёт', () => {
    const m = modelOf(
      'CREATE TABLE partners (\n  id UUID PRIMARY KEY,\n  guide_operator_id UUID REFERENCES partners(id)\n);',
      'ALTER TABLE partners ADD COLUMN IF NOT EXISTS guide_operator_id BIGINT REFERENCES users(id);\nALTER TABLE partners ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);',
    );
    expect(fk(m, 'partners.guide_operator_id')).toBe('partners.id');
    expect(fk(m, 'partners.user_id')).toBe('users.id');
  });

  it('явная команда ключа позже — переписывает', () => {
    const m = modelOf(
      'CREATE TABLE booking_logs (\n  id UUID PRIMARY KEY,\n  booking_id UUID REFERENCES bookings(id)\n);',
      'ALTER TABLE booking_logs ADD CONSTRAINT booking_logs_booking_fk FOREIGN KEY (booking_id) REFERENCES operator_bookings(id);',
    );
    expect(fk(m, 'booking_logs.booking_id')).toBe('operator_bookings.id');
  });

  it('строки-продолжения ограничения колонками не считаются', () => {
    const m = modelOf("CREATE TABLE edits (\n  id UUID PRIMARY KEY,\n  status TEXT NOT NULL,\n  CONSTRAINT edits_status CHECK (\n    status = 'pending'\n    OR status = 'approved'\n    AND id IS NOT NULL\n  )\n);");
    expect(cols(m, 'edits')).toEqual(['id', 'status']);
  });
});

describe('комментарии SQL — не команды', () => {
  it('строчный и блочный комментарий убраны, перевод строки сохранён', () => {
    expect(stripSqlComments('SELECT 1; -- ALTER TABLE a RENAME TO b;\nSELECT 2; /* DROP\nTABLE x */ SELECT 3;'))
      .toBe('SELECT 1; \nSELECT 2;   SELECT 3;');
  });

  it('два дефиса внутри строки в кавычках — не комментарий', () => {
    const sql = "COMMENT ON TABLE t IS 'срок -- до конца тура; it''s';\nALTER TABLE t ADD COLUMN x INT;";
    expect(stripSqlComments(sql)).toBe(sql);
    const m = modelOf('CREATE TABLE t (\n  id INT\n);', sql);
    expect(cols(m, 't')).toEqual(['id', 'x']);
  });

  it('колонка из закомментированной команды в модель не попадает', () => {
    const m = modelOf('CREATE TABLE t (\n  id INT\n);', '-- ALTER TABLE t ADD COLUMN ghost INT;\n/* ALTER TABLE t ADD COLUMN ghost2 INT; */');
    expect(cols(m, 't')).toEqual(['id']);
  });
});

describe('поверх baseline доигрываются только миграции новее него', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repo(baselineHeader: string): string {
    const root = mkdtempSync(join(tmpdir(), 'schema-model-'));
    dirs.push(root);
    mkdirSync(join(root, 'lib/database/baseline'), { recursive: true });
    mkdirSync(join(root, 'migrations'));
    writeFileSync(
      join(root, 'lib/database/baseline/schema-baseline.sql'),
      `${baselineHeader}\nCREATE TABLE operator_bookings (\n  id BIGINT PRIMARY KEY,\n  operator_tour_id BIGINT\n);\n`,
    );
    // Вошла в снимок: её колонки в базе нет (на проде её убрали до снимка).
    writeFileSync(join(root, 'migrations/005_old.sql'), 'ALTER TABLE operator_bookings ADD COLUMN IF NOT EXISTS tour_id UUID;\n');
    writeFileSync(join(root, 'migrations/010_last_in_snapshot.sql'), 'ALTER TABLE operator_bookings ADD COLUMN IF NOT EXISTS total_amount NUMERIC;\n');
    writeFileSync(join(root, 'migrations/011_new.sql'), 'ALTER TABLE operator_bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;\n');
    writeFileSync(join(root, 'migrations/1000_newer.sql'), 'ALTER TABLE operator_bookings ADD COLUMN IF NOT EXISTS agent_user_id UUID;\n');
    return root;
  }

  it('миграция, вошедшая в снимок, колонок не добавляет; новее — добавляет', () => {
    const root = repo('-- Baseline\n-- Последняя миграция в снимке: 010_last_in_snapshot.sql\n');
    const m = loadSchemaModel(root);
    expect(cols(m, 'operator_bookings')).toEqual(['agent_user_id', 'id', 'operator_tour_id', 'paid_at']);
  });

  it('граница не записана — доигрываются все, и об этом сказано', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const m = loadSchemaModel(repo('-- Baseline без строки границы\n'));
    expect(cols(m, 'operator_bookings')).toEqual(['agent_user_id', 'id', 'operator_tour_id', 'paid_at', 'total_amount', 'tour_id']);
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0][0])).toContain('доигрываются все миграции');
  });

  it('граница записана — в лог ничего не пишется', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    loadSchemaModel(repo('-- Baseline\n-- Последняя миграция в снимке: 010_last_in_snapshot.sql\n'));
    expect(said).not.toHaveBeenCalled();
  });

  it('имя, ставшее вьюхой, как таблица не судится', () => {
    // agent_route_knowledge: была таблица, стала VIEW поверх двух других
    // (миграция 663). Состав вьюхи выводится из её запроса — судить
    // обращения к ней по колонкам прежней таблицы значит клеймить рабочий код.
    const root = repo('-- Baseline\n-- Последняя миграция в снимке: 010_last_in_snapshot.sql\n');
    writeFileSync(
      join(root, 'migrations/012_view.sql'),
      'CREATE TABLE knowledge (\n  id UUID PRIMARY KEY,\n  title TEXT\n);\n',
    );
    writeFileSync(
      join(root, 'migrations/013_view.sql'),
      'DROP TABLE knowledge;\nCREATE OR REPLACE VIEW knowledge AS SELECT id, operator_tour_id AS title FROM operator_bookings;\n',
    );
    const m = loadSchemaModel(root);
    expect(m.views.has('knowledge')).toBe(true);
    expect(m.columns.has('knowledge')).toBe(false);
    expect(scanSourceAgainstSchema('x.ts', 'const q = `SELECT k.anything FROM knowledge k`;', m)).toEqual([]);
  });

  it('нет baseline — модель пустая, а не собранная из одних миграций', () => {
    const root = mkdtempSync(join(tmpdir(), 'schema-model-'));
    dirs.push(root);
    mkdirSync(join(root, 'migrations'));
    writeFileSync(join(root, 'migrations/900_x.sql'), 'CREATE TABLE x (\n  id INT\n);\n');
    expect(loadSchemaModel(root).columns.size).toBe(0);
  });
});

describe('репозиторий: таблицы, о которых заводились ложные задачи', () => {
  const schema = loadSchemaModel(process.cwd());
  const unknownColumns = (file: string) =>
    scanSourceAgainstSchema(file, readFileSync(join(process.cwd(), file), 'utf-8'), schema)
      .map((m) => `${m.kind}: ${m.message}`);

  it('переписка заявки: body, author и остальные колонки известны (#3343, #3268)', () => {
    for (const c of ['id', 'body', 'author', 'door', 'stay_request_id', 'lead_id', 'created_at', 'delivery_channel', 'translation']) {
      expect(schema.columns.get('request_messages')?.has(c), `request_messages.${c}`).toBe(true);
    }
    expect(schema.columns.has('stay_request_messages')).toBe(false);
  });

  it('ожидания ответа в чате: status и остальные колонки известны (#2891)', () => {
    for (const c of ['id', 'status', 'chat_id', 'channel', 'side', 'expires_at', 'stay_request_id', 'lead_id']) {
      expect(schema.columns.get('request_chat_waits')?.has(c), `request_chat_waits.${c}`).toBe(true);
    }
  });

  it.each([
    'lib/mcp/partner-messages.ts',
    'lib/requests/my-trip-date.ts',
    'lib/guides/chat-role/store.ts',
  ])('в %s объектив ничего не находит', (file) => {
    expect(unknownColumns(file)).toEqual([]);
  });

  it('ключи, объявленные в миграциях рядом с колонкой, известны', () => {
    expect(fk(schema, 'operator_bookings.guide_partner_id')).toBe('partners.id');
    expect(fk(schema, 'operator_bookings.agent_user_id')).toBe('users.id');
    expect(fk(schema, 'partner_incoming_answers.partner_id')).toBe('partners.id');
    expect(fk(schema, 'mchs_letters.partner_id')).toBe('partners.id');
    expect(fk(schema, 'partners.guide_operator_id')).toBe('partners.id');
    // Старое объявление из миграции до снимка нынешний ключ не затёрло.
    expect(fk(schema, 'location_safety_profile.agent_route_id')).toBe('places.ark_id');
  });

  it('соединение двух ссылок на одну таблицу — не «мимо ключа»', () => {
    const src = 'const q = `SELECT l.id FROM leads l JOIN partner_incoming_answers a ON a.partner_id = l.operator_id`;';
    expect(scanSourceAgainstSchema('x.ts', src, schema)).toEqual([]);
    const team = 'const q = `SELECT t.id FROM operator_tours t JOIN partners g ON g.guide_operator_id = t.operator_id`;';
    expect(scanSourceAgainstSchema('x.ts', team, schema)).toEqual([]);
  });

  it('колонка из миграции до снимка, которой в базе нет, больше не числится', () => {
    // CLAUDE.md §4: у operator_bookings нет tour_id, есть operator_tour_id
    // (#1772). Пока модель доигрывала миграции до снимка, запрос к tour_id
    // объектив пропускал.
    expect(schema.columns.get('operator_bookings')?.has('tour_id')).toBe(false);
    expect(schema.columns.get('operator_bookings')?.has('operator_tour_id')).toBe(true);
    const src = 'const q = `SELECT b.tour_id FROM operator_bookings b`;';
    expect(scanSourceAgainstSchema('x.ts', src, schema).map((m) => m.message))
      .toEqual(['в таблице operator_bookings нет колонки tour_id — запрос упадёт']);
  });

  it('удалённые миграцией 1021 колонки расписания гида не числятся', () => {
    expect(schema.columns.get('guide_schedule')?.has('tour_id')).toBe(false);
    expect(schema.columns.get('guide_schedule')?.has('booking_id')).toBe(false);
    expect(schema.columns.get('guide_schedule')?.has('operator_booking_id')).toBe(true);
  });
});

/**
 * Находки объектива по всему репозиторию — известны поимённо.
 *
 * Объектив работает ночью и заводит задачи. Эта сверка идёт в CI: запрос к
 * колонке, которой нет, и соединение мимо ключа краснеют в своём PR, а не
 * через сутки задачей. Список только сокращается: починил — запись обязана
 * уйти (тест потребует). Новая запись — только с причиной, почему находка не
 * чинится сейчас; ложную находку чинят в объективе, а не вносят сюда.
 */
const KNOWN_MISMATCHES: Array<{ file: string; message: string; count: number; why: string }> = [
  {
    file: 'lib/search/tour-recommend.ts',
    message: 'в таблице operator_tours нет колонки eco_points_reward — запрос упадёт',
    count: 2,
    why: 'настоящая: третья стратегия личных рекомендаций падает на каждом вызове (отказ назван в логе, '
      + 'список стратегии пуст). Колонки не было никогда; завести её или снять стратегию — решение владельца.',
  },
];

describe('объектив по всему репозиторию', () => {
  it('находит только известное — и каждое известное ещё на месте', async () => {
    const schema = loadSchemaModel(process.cwd());
    const files = (await listRepoFiles()).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    // Горстка файлов — не репозиторий: сверка по ней была бы зелёной впустую.
    expect(files.length).toBeGreaterThan(1500);

    const found = new Map<string, number>();
    for (const file of files) {
      const src = readFileSync(join(process.cwd(), file), 'utf-8');
      for (const m of scanSourceAgainstSchema(file, src, schema)) {
        const key = `${m.file} · ${m.message}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
    const known = new Map(KNOWN_MISMATCHES.map((k) => [`${k.file} · ${k.message}`, k.count]));

    const fresh = [...found].filter(([k, n]) => n > (known.get(k) ?? 0)).map(([k, n]) => `${k} ×${n}`);
    expect(
      fresh,
      'запрос спорит со схемой (baseline + миграции). Колонка нужна — заведите миграцией; '
        + 'переименована — поправьте запрос. Если объектив ошибся — чинится он '
        + '(lib/agents/evo/schema-lens.ts, schema-model.ts), а не этот список',
    ).toEqual([]);

    const gone = [...known].filter(([k, n]) => (found.get(k) ?? 0) < n).map(([k]) => k);
    expect(gone, 'находка исправлена — уберите или уменьшите запись в KNOWN_MISMATCHES').toEqual([]);
  });

  it('у каждой известной записи названа причина', () => {
    for (const k of KNOWN_MISMATCHES) expect(k.why.length, k.file).toBeGreaterThan(40);
  });
});
