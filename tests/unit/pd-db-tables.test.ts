/**
 * Сторож ПД, сток «база» (слово владельца 16.11 «го», после вливания #3456).
 *
 * Каждая таблица, в которую код пишет имя или телефон человека, записана в
 * PD_TABLES, и её род хранения сверен с механизмами: уборка сроков, перепись
 * сроков, удаление аккаунта. Публичный контент ПД не принимает вовсе — так
 * поймался бы случай #3460 (подписи людей из групп Telegram в каталоге
 * маршрутов).
 *
 * Шаги удаления аккаунта берутся вызовом eraseUser на записывающей заглушке
 * (тот же помощник, что у сторожа полноты удаления), а не чтением исходника.
 */
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { scanSinks, sqlWrites, pdKindOf, exportedSqlConsts, SQL_UNPARSED } from '@/lib/agents/compliance/pd-sinks';
import { sinkCensusOfRepo, sinkCensus, sinkSourcesOfRepo } from '@/lib/agents/compliance/pd-sinks-registry';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  PD_TABLES, PUBLIC_CONTENT_TABLES, dbCensus, keptOf, type RetentionMechanisms,
} from '@/lib/agents/compliance/pd-db-tables';
import { PURGE_STEPS } from '@/lib/legal/retention-purge';
import { RETENTION_TARGETS } from '@/lib/legal/retention-census';
import { recordEraseSteps } from '../helpers/pd-census';

const REPO = join(__dirname, '..', '..');
const show = (xs: unknown) => JSON.stringify(xs, null, 2);

let mechanisms: RetentionMechanisms;
beforeAll(async () => {
  const erase = await recordEraseSteps();
  mechanisms = {
    purge: new Set(PURGE_STEPS.map((s) => s.table)),
    measured: new Set(RETENTION_TARGETS.map((t) => t.table)),
    erase: new Set(erase.map((s) => s.table)),
  };
});

describe('перепись репозитория: запись ПД в базу', () => {
  const census = sinkCensusOfRepo(REPO);

  it('сторож видит запись в базу вообще (ноль находок — отказ, а не чистота)', () => {
    expect(census.dbFindings.length).toBeGreaterThan(20);
    expect(new Set(census.dbFindings.flatMap((f) => f.tables ?? [])).has('leads')).toBe(true);
  });

  it('ПД не пишутся в публичный контент: каталог маршрутов, места, их снимки и переводы', () => {
    const c = dbCensus(census.dbFindings, mechanisms);
    expect(c.publicContent, `ПД в публичной таблице. Уберите поле или пропустите его через маску (PD_SANITIZERS):\n${show(c.publicContent)}`).toEqual([]);
  });

  it('у каждого запроса с ПД найден текст: таблица известна', () => {
    const c = dbCensus(census.dbFindings, mechanisms);
    expect(c.unparsed, `Запрос пишет ПД, а текст запроса сторож не нашёл (импорт под другим именем, сборка вызовом). Вынесите текст в константу с тем же именем:\n${show(c.unparsed)}`).toEqual([]);
  });

  it('каждая таблица с ПД записана в PD_TABLES', () => {
    const c = dbCensus(census.dbFindings, mechanisms);
    expect(c.unregistered.map((u) => u.table), `Новая таблица с ПД. Скажите в PD_TABLES, что там лежит, и как строки уходят (уборка сроков, перепись, удаление аккаунта или пробел с причиной):\n${show(c.unregistered)}`).toEqual([]);
  });

  it('реестр не устарел и род хранения совпадает с механизмами', () => {
    const c = dbCensus(census.dbFindings, mechanisms);
    expect(c.stale.map((e) => e.table), 'в таблицу больше никто не пишет ПД — запись удалить').toEqual([]);
    expect(c.wrongKept, 'род хранения разошёлся с реестрами сроков и шагами удаления аккаунта — обновите kept (пробел закрыт или механизм снят)').toEqual([]);
  });

  it('у записей есть смысл; публичный контент в реестр не вносится', () => {
    const tables = PD_TABLES.map((e) => e.table);
    expect(new Set(tables).size).toBe(tables.length);
    for (const e of PD_TABLES) {
      expect(e.holds.trim().length, e.table).toBeGreaterThan(8);
      if (e.kept === 'gap') expect(e.why?.trim().length ?? 0, `${e.table}: пробел без причины`).toBeGreaterThan(20);
      expect(PUBLIC_CONTENT_TABLES, `${e.table}: публичный контент ПД не принимает ни с какой причиной`).not.toContain(e.table);
    }
  });
});

describe('случай #3460 ловится', () => {
  const src = [
    'buf.messages.push({ from: fromName, text: text.slice(0, 400) });',
    'await pool.query(',
    '  `INSERT INTO kamchatka_routes (dedupe_key, metadata) VALUES ($1, $2::jsonb)',
    '   ON CONFLICT (dedupe_key) DO UPDATE SET metadata = EXCLUDED.metadata`,',
    '  [dedupe, JSON.stringify({',
    '    tips: intel.traveler_tips,',
    '    sample: messages.slice(-3).map(m => `${m.from}: ${m.text.slice(0, 100)}`),',
    '  })],',
    ');',
  ].join('\n');

  it('подпись автора, положенная файлом в поле, находится в параметрах записи', () => {
    const f = scanSinks('lib/telegram/group-monitor.ts', src);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'db', sink: 'INSERT INTO kamchatka_routes', pd: 'name', tables: ['kamchatka_routes'] });
    expect(f[0].expr).toBe('m.from ← from: fromName');
  });

  it('и это нарушение без права на запись в реестре', () => {
    const c = dbCensus(scanSinks('lib/telegram/group-monitor.ts', src), { purge: new Set(), measured: new Set(), erase: new Set() });
    expect(c.publicContent).toHaveLength(1);
    expect(c.unregistered).toEqual([]);
  });

  it('подпись под маской — не находка', () => {
    const masked = src.replace('${m.from}', '${redactPII(m.from)}');
    expect(scanSinks('lib/telegram/group-monitor.ts', masked)).toEqual([]);
  });

  it('подпись автора — имя человека', () => {
    expect(pdKindOf('fromName')).toBe('name');
    expect(pdKindOf('author_name')).toBe('name');
    expect(pdKindOf('senderName')).toBe('name');
    expect(pdKindOf('from')).toBeNull();
  });
});

describe('что считается записью', () => {
  it('INSERT и UPDATE … SET — да; DO UPDATE SET — не таблица «set»', () => {
    expect(sqlWrites('INSERT INTO public.leads (phone) VALUES ($1) ON CONFLICT (id) DO UPDATE SET phone = $1')).toEqual([{ op: 'INSERT INTO', table: 'leads' }]);
    expect(sqlWrites('UPDATE "users" u SET phone = $1 WHERE u.id = $2')).toEqual([{ op: 'UPDATE', table: 'users' }]);
    expect(sqlWrites('UPDATE stay_requests AS s SET guest_phone = $1')).toEqual([{ op: 'UPDATE', table: 'stay_requests' }]);
    expect(sqlWrites('SELECT * FROM leads WHERE phone = $1')).toEqual([]);
    expect(sqlWrites('DELETE FROM leads WHERE phone = $1')).toEqual([]);
  });

  it('чтение с телефоном в параметре — не запись', () => {
    expect(scanSinks('lib/x.ts', 'await pool.query(`SELECT id FROM leads WHERE phone = $1`, [lead.phone]);')).toEqual([]);
  });

  it('текст запроса в константе, обобщённый тип, клиент транзакции', () => {
    const src = [
      "const SQL = 'INSERT INTO stay_requests (guest_name, guest_phone) VALUES ($1, $2)';",
      'await client.query<Record<string, unknown>>(SQL, [i.guestName, i.guestPhone]);',
    ].join('\n');
    const f = scanSinks('lib/stay/x.ts', src);
    expect(f.map((x) => x.expr)).toEqual(['i.guestName', 'i.guestPhone']);
    expect(f.every((x) => x.sink === 'INSERT INTO stay_requests')).toBe(true);
  });

  it('проверка наличия и счёт — не значение', () => {
    const src = 'await pool.query(`UPDATE leads SET has_phone = $1, n = $2 WHERE id = $3`, [!!lead.phone, lead.phone.length, id]);';
    expect(scanSinks('lib/x.ts', src)).toEqual([]);
  });
});

describe('текст запроса из соседнего модуля (ревью #3499)', () => {
  const lib = 'export const UPDATE_STAY_SQL = `UPDATE accommodation_bookings SET guest_phone = $1 WHERE id = $2`;\nexport const LIMIT = 10;';
  const route = "import { UPDATE_STAY_SQL } from '@/lib/stay/sql';\nawait client.query(UPDATE_STAY_SQL, [b.guestPhone, id]);";

  it('экспортированная константа подставляется, и таблица названа', () => {
    expect([...exportedSqlConsts(lib).keys()]).toEqual(['UPDATE_STAY_SQL']);
    const c = sinkCensus([{ rel: 'lib/stay/sql.ts', src: lib }, { rel: 'app/api/stay/route.ts', src: route }], []);
    expect(c.dbFindings.map((f) => [f.file, f.sink, f.expr, f.tables])).toEqual([
      ['app/api/stay/route.ts', 'UPDATE accommodation_bookings', 'b.guestPhone', ['accommodation_bookings']],
    ]);
    expect(c.violations).toEqual([]);
  });

  it('текст не нашёлся — находка «не разобран», а не тишина', () => {
    const f = scanSinks('app/api/stay/route.ts', route);
    expect(f.map((x) => [x.sink, x.expr, x.tables])).toEqual([['query(UPDATE_STAY_SQL)', 'b.guestPhone', [SQL_UNPARSED]]]);
    const none: RetentionMechanisms = { purge: new Set(), measured: new Set(), erase: new Set() };
    const c = dbCensus(f, none, []);
    expect(c.unparsed).toHaveLength(1);
    expect(c.unregistered).toEqual([]);
  });

  it('обёртка с параметрами без имён ПД — не находка', () => {
    expect(scanSinks('lib/db.ts', 'export async function run(sql: string, params: unknown[]) { return pool.query(sql, params); }')).toEqual([]);
  });
});

describe('файлы корня репозитория (ревью #3499)', () => {
  it('серверные файлы корня читаются переписью', () => {
    const rels = new Set(sinkSourcesOfRepo(REPO).map((s) => s.rel));
    for (const f of ['instrumentation.ts', 'middleware.ts', 'start.js']) expect(rels.has(f)).toBe(true);
  });

  it('запись ПД в базу из файла корня — находка, подкаталог корня не читается дважды', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pd-root-'));
    try {
      writeFileSync(join(dir, 'instrumentation.ts'), "await pool.query('INSERT INTO ai_actions_log (metadata) VALUES ($1)', [user.email]);");
      writeFileSync(join(dir, 'next.config.d.ts'), "await pool.query('INSERT INTO t (a) VALUES ($1)', [user.email]);");
      mkdirSync(join(dir, 'lib'));
      writeFileSync(join(dir, 'lib', 'x.ts'), "await pool.query('INSERT INTO stay_requests (phone) VALUES ($1)', [b.phone]);");
      const c = sinkCensusOfRepo(dir);
      expect(c.dbFindings.map((f) => [f.file, f.tables])).toEqual([
        ['instrumentation.ts', ['ai_actions_log']],
        ['lib/x.ts', ['stay_requests']],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('сверка с реестром', () => {
  const finding = (table: string) => ({ file: 'lib/x.ts', line: 1, sink: `INSERT INTO ${table}`, expr: 'phone', tables: [table] });
  const none: RetentionMechanisms = { purge: new Set(), measured: new Set(), erase: new Set() };

  it('новая таблица — красная, запись без писателя — красная', () => {
    const c = dbCensus([finding('new_table')], none, [{ table: 'old_table', kept: 'gap', holds: 'телефон клиента', why: 'x'.repeat(30) }]);
    expect(c.unregistered.map((u) => u.table)).toEqual(['new_table']);
    expect(c.stale.map((e) => e.table)).toEqual(['old_table']);
  });

  it('пробел, у которого появилась уборка, требует обновить род', () => {
    const reg = [{ table: 't', kept: 'gap' as const, holds: 'телефон клиента', why: 'x'.repeat(30) }];
    const c = dbCensus([finding('t')], { ...none, purge: new Set(['t']) }, reg);
    expect(c.wrongKept).toEqual([{ table: 't', declared: 'gap', actual: 'purge' }]);
  });

  it('род — сильнейший механизм', () => {
    const m: RetentionMechanisms = { purge: new Set(['a']), measured: new Set(['a', 'b']), erase: new Set(['a', 'b', 'c']) };
    expect([keptOf('a', m), keptOf('b', m), keptOf('c', m), keptOf('d', m)]).toEqual(['purge', 'measured', 'erase', 'gap']);
  });
});
