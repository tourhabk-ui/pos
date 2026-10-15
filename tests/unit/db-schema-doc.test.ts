/**
 * docs/DB_SCHEMA.md — справочник схемы, снятый с настоящей базы.
 *
 * ── Что изменилось 15.10 (аудит, AR-schema-doc) ──────────────────────────
 *
 * До этого дня сторож требовал, чтобы справочник был снят не раньше
 * последней схемной миграции В ВЕТКЕ. Каждая сессия со схемной миграцией
 * перегенерировала его в своём PR, и общий файл стал местом столкновений:
 * 15.10 PR #2511 встал в конфликт с main только из-за него, а на PR с
 * конфликтом GitHub не запускает проверок — около 25 минут простоя.
 *
 * Теперь справочник снимает job `.github/workflows/db-schema-doc.yml` после
 * влития миграций в main. Ветке разрешено отставать на свои миграции — их в
 * main ещё нет. Сторож держит связку, а не половину (правило 10.09):
 *   1. производитель существует, срабатывает на влитие миграций, собирает
 *      базу штатным путём и коммитит со [skip ci], отказ — красный;
 *   2. справочник отстаёт не больше, чем на MAX_SCHEMA_LAG схемных
 *      миграций — порог, за которым отставание объясняется уже не «миграции
 *      этой ветки ещё не влиты», а «производитель не работает»;
 *   3. правило свежести и сброс отметок проверяются вызовом на граничных
 *      данных, а не поиском строк.
 *
 * ── Почему порог по числу, а не «старше N дней в main» ───────────────────
 *
 * Точный вопрос — «есть ли в main схемная миграция, влитая больше суток
 * назад, а справочник её не видит» — требует истории git. В CI её нет:
 * checkout для pull_request берёт один merge-коммит (fetch-depth 1), и
 * сторож, который без истории молча пропускается, был бы вечно зелёным.
 * Порог по числу проверяем без сети и без истории в любом checkout.
 *
 * Откалиброван замером 15.10 по main с 15.08 (51 день): схемных миграций
 * 147, в среднем 3 в сутки, максимум 11 в сутки и 4 в одном коммите. Ветка
 * со своими миграциями и пара соседних, влитых минуту назад, под порог
 * уходят; мёртвый производитель упирается в него за 1–4 дня — и тогда
 * красный каждый PR, с указанием, где искать причину.
 *
 * Содержимое справочника не проверяется — оно снимается с базы, и судить его
 * статикой запрещено. Проверяется свежесть и то, что ядро §4.1 на месте.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  BASELINE_TAKEN_ON,
  FIRST_MIGRATION_AFTER_BASELINE,
  migrationNumber,
} from '@/lib/database/migration-order';
import {
  changesSchema,
  judgeFreshness,
  resetAfterBaseline,
  schemaLag,
  snapshotMigration,
  type Queryable,
} from '@/lib/database/schema-doc-freshness';

const ROOT = process.cwd();
const DOC = join(ROOT, 'docs', 'DB_SCHEMA.md');
const MIGRATIONS = join(ROOT, 'migrations');
const PRODUCER = '.github/workflows/db-schema-doc.yml';

/** Сколько схемных миграций справочник может не видеть. Калибровка — в шапке. */
const MAX_SCHEMA_LAG = 10;

const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
}

function isSchemaFile(file: string): boolean {
  let body: string | null;
  try {
    body = readFileSync(join(MIGRATIONS, file), 'utf-8');
  } catch {
    // Не прочитался — НЕ ЗНАЕМ, что в нём; changesSchema(null) считает его
    // схемным, то есть ошибается в сторону «справочник отстал».
    body = null;
  }
  return changesSchema(body);
}

describe('docs/DB_SCHEMA.md — справочник схемы БД', () => {
  it('существует и порождён генератором, а не написан руками', () => {
    expect(existsSync(DOC)).toBe(true);
    const body = readFileSync(DOC, 'utf-8');
    expect(body).toContain('scripts/gen-db-schema.ts');
    expect(body).toMatch(/Снято \d{4}-\d{2}-\d{2} с настоящего PostgreSQL/);
  });

  it('шапка подписана миграцией, с которой снят снимок', () => {
    expect(snapshotMigration(readFileSync(DOC, 'utf-8')), 'в шапке нет имени последней миграции').not.toBeNull();
  });

  it(`отстаёт не больше чем на ${MAX_SCHEMA_LAG} схемных миграций — иначе производитель не работает`, () => {
    const verdict = judgeFreshness(readFileSync(DOC, 'utf-8'), migrationFiles(), isSchemaFile);
    expect(verdict.state, verdict.state === 'unknown' ? verdict.reason : '').not.toBe('unknown');
    const lag = verdict.state === 'stale' ? verdict.lag : [];
    expect(
      lag.length,
      `docs/DB_SCHEMA.md не видит ${lag.length} схемных миграций: ${lag.join(', ')}. ` +
        'Миграции своей ветки справочник видеть не обязан — его снимает job ' +
        `${PRODUCER} после влития. Отставание сверх порога значит, что job не снимал ` +
        'справочник несколько мержей подряд: смотреть его прогоны в Actions. Снять руками ' +
        'можно (шапка scripts/gen-db-schema.ts), но причина останется.',
    ).toBeLessThanOrEqual(MAX_SCHEMA_LAG);
  });

  it('ядро §4.1 присутствует: три master-таблицы и их связка', () => {
    const body = readFileSync(DOC, 'utf-8');
    for (const t of ['places', 'kamchatka_routes', 'operator_tours', 'route_waypoints', 'operator_bookings', 'sos_events', 'external_alerts']) {
      expect(body, `в справочнике нет таблицы ${t}`).toContain(`**${t}**`);
    }
    // Связи, которых в базе нет (держит код), обязаны быть нарисованы пунктиром —
    // читатель должен видеть, что FK их не охраняет.
    expect(body).toContain('places ||..o{ location_safety_profile');
    expect(body).toContain('places ||..o{ ai_route_images');
  });

  it('генератор доступен одной командой', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:schema-doc']).toContain('scripts/gen-db-schema.ts');
  });
});

describe('правило свежести — на граничных данных', () => {
  const doc = (name: string) => `> Снято 2026-10-15 ... Последняя миграция в снимке: \`${name}\`.`;
  const schema = new Set(['998_add_col.sql', '1000_create_t.sql', '1001_alter.sql']);
  const isSchema = (f: string) => schema.has(f);
  const files = ['997_seed.sql', '998_add_col.sql', '999_seed.sql', '1000_create_t.sql', '1001_alter.sql', '1002_seed.sql'];

  it('снимок с последней схемной миграции, после неё только данные — свежий', () => {
    expect(judgeFreshness(doc('1001_alter.sql'), files, isSchema)).toEqual({ state: 'fresh', snapshot: '1001_alter.sql' });
    // Снят позже последней схемной (на data-only) — тоже свежий, просто свежее необходимого.
    expect(judgeFreshness(doc('1002_seed.sql'), files, isSchema).state).toBe('fresh');
  });

  it('схемная миграция новее снимка — отставание, по ЧИСЛУ, а не по строке', () => {
    // '1000_' посимвольно меньше '999_': строковое сравнение сочло бы 1000 и
    // 1001 старше снимка и объявило справочник свежим.
    expect(judgeFreshness(doc('999_seed.sql'), files, isSchema)).toEqual({
      state: 'stale', snapshot: '999_seed.sql', lag: ['1000_create_t.sql', '1001_alter.sql'], missing: false,
    });
    expect(schemaLag(files, '997_seed.sql', isSchema)).toEqual(['998_add_col.sql', '1000_create_t.sql', '1001_alter.sql']);
  });

  it('подписанного файла нет в каталоге — отставание считается по порядку, а снять всё равно надо', () => {
    // Случай перенумерации: снимок с 999_old.sql, а файл с тех пор переименован.
    expect(judgeFreshness(doc('999_old.sql'), files, isSchema)).toEqual({
      state: 'stale', snapshot: '999_old.sql', lag: ['1000_create_t.sql', '1001_alter.sql'], missing: true,
    });
    expect(judgeFreshness(doc('1001_renamed.sql'), files, isSchema)).toEqual({
      state: 'stale', snapshot: '1001_renamed.sql', lag: [], missing: true,
    });
  });

  it('без файла или без подписи — «не знаю», а не «свежий»', () => {
    expect(judgeFreshness(null, files, isSchema).state).toBe('unknown');
    expect(judgeFreshness('# Схема базы данных Ведара\n', files, isSchema).state).toBe('unknown');
  });

  it('data-only миграция справочник не старит, схемная — старит', () => {
    expect(changesSchema('ALTER TABLE partners ADD COLUMN x text;'), 'ALTER не опознан').toBe(true);
    expect(changesSchema("INSERT INTO partners (name) SELECT 'Яна' WHERE NOT EXISTS (SELECT 1);"), 'INSERT принят за схему').toBe(false);
    expect(changesSchema('-- когда-то здесь был CREATE TABLE\nINSERT INTO t VALUES (1);'), 'DDL в строчном комментарии').toBe(false);
    expect(changesSchema('/* DROP TABLE t */ UPDATE t SET a = 1;'), 'DDL в блочном комментарии').toBe(false);
    // DDL, собранный строкой внутри DO-блока, — тоже схема.
    expect(changesSchema("DO $$ BEGIN EXECUTE 'create index i on t(a)'; END $$;")).toBe(true);
    expect(changesSchema('COMMENT ON COLUMN t.a IS $c$x$c$;')).toBe(true);
    // Не прочитался — считается схемным: ошибка только в сторону «снять».
    expect(changesSchema(null)).toBe(true);
  });
});

describe('сброс отметок новее baseline — на поддельной базе', () => {
  /** База, в которой bootstrap пометил применёнными `marked`; пишет, что у неё спросили. */
  function fakeDb(marked: string[], opts: { deleteLoses?: number } = {}) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db: Queryable = {
      async query<R extends Record<string, unknown>>(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (/^SELECT name FROM _migrations/.test(sql)) {
          return { rows: marked.map((name) => ({ name })) as unknown as R[] };
        }
        if (/^DELETE FROM _migrations/.test(sql)) {
          const names = (params?.[0] as string[]).slice(opts.deleteLoses ?? 0);
          return { rows: names.map((name) => ({ name })) as unknown as R[] };
        }
        throw new Error(`неожиданный запрос: ${sql}`);
      },
    };
    return { db, calls };
  }
  const files = ['040_old.sql', '144a_table.sql', '862_last_in_baseline.sql', '863_first_after.sql', '999_x.sql', '1000_y.sql', 'readme.sql'];

  it('снимает ровно то, что новее границы, по числу, и называет снятое', async () => {
    const { db, calls } = fakeDb(files);
    const reset = await resetAfterBaseline(db, files, 863);
    expect(reset).toEqual(['863_first_after.sql', '999_x.sql', '1000_y.sql']);
    const deleted = calls.find((c) => c.sql.startsWith('DELETE'))?.params?.[0] as string[] | undefined;
    expect([...(deleted ?? [])].sort()).toEqual(['1000_y.sql', '863_first_after.sql', '999_x.sql']);
  });

  it('bootstrap не пометил миграции — отказ, а не «снято 0»', async () => {
    // Иначе npm run migrate не применит ничего, а генератор подпишет снимок
    // голого baseline именем последней миграции.
    await expect(resetAfterBaseline(fakeDb([]).db, files, 863)).rejects.toThrow(/bootstrap не пометил/);
  });

  it('граница вне каталога — отказ', async () => {
    await expect(resetAfterBaseline(fakeDb(files).db, files, 5000)).rejects.toThrow(/нет ни одного файла/);
  });

  it('удалилось меньше, чем отобрано, — отказ с числами', async () => {
    await expect(resetAfterBaseline(fakeDb(files, { deleteLoses: 1 }).db, files, 863)).rejects.toThrow(/снято 2 отметок из 3/);
  });
});

describe('граница baseline — одна и сверена со снимком', () => {
  it('baseline снят в тот день, к которому привязана граница', () => {
    // Переснят baseline (db-baseline.yml) — шапка назовёт другой день. Тогда
    // FIRST_MIGRATION_AFTER_BASELINE устарела: сборка справочника сняла бы
    // отметки не с тех миграций. Сверить границу и обновить обе константы.
    const head = read('lib/database/baseline/schema-baseline.sql').split('\n').slice(0, 8).join('\n');
    expect(head, `шапка baseline не называет ${BASELINE_TAKEN_ON} — граница baseline не сверена`).toContain(BASELINE_TAKEN_ON);
  });

  it('граница стоит на каталоге, а не в пустоте', () => {
    const numbers = new Set(migrationFiles().map(migrationNumber));
    expect(numbers.has(FIRST_MIGRATION_AFTER_BASELINE - 1), 'нет последней миграции baseline').toBe(true);
    expect(numbers.has(FIRST_MIGRATION_AFTER_BASELINE), 'нет первой миграции после baseline').toBe(true);
  });
});

// ── Производитель ──────────────────────────────────────────────────────────

interface Step { id?: string; name?: string; if?: string; run?: string; uses?: string; 'continue-on-error'?: unknown }
interface Job {
  permissions?: Record<string, string>;
  services?: Record<string, { image?: string }>;
  steps?: Step[];
  'continue-on-error'?: unknown;
}
interface Workflow { on?: Record<string, unknown>; jobs?: Record<string, Job> }

/** В YAML `on:` разбирается как булево true — это не опечатка. */
function workflow(path: string): Workflow {
  const doc = load(read(path)) as Record<string, unknown>;
  return { on: (doc['on'] ?? doc[true as unknown as string]) as Record<string, unknown>, jobs: doc['jobs'] as Record<string, Job> };
}

function pgMajor(image: string | undefined): number | null {
  const m = /^postgres:(\d+)/.exec(image ?? '');
  return m ? Number(m[1]) : null;
}

describe('производитель: job после влития снимает справочник', () => {
  const wf = workflow(PRODUCER);
  const job = Object.values(wf.jobs ?? {}).find((j) => (j.steps ?? []).some((s) => /npm run db:schema-doc/.test(s.run ?? '')));
  const steps = job?.steps ?? [];
  const at = (re: RegExp) => steps.findIndex((s) => re.test(s.run ?? ''));

  it('job, снимающий справочник, есть', () => {
    expect(job, `в ${PRODUCER} нет шага npm run db:schema-doc`).toBeDefined();
  });

  it('срабатывает на влитие миграций в main и не заводит расписания', () => {
    const push = wf.on?.push as { branches?: string[]; paths?: string[] } | undefined;
    expect(push?.branches).toContain('main');
    expect(push?.paths, 'без migrations/** влитая миграция справочник не снимет').toContain('migrations/**');
    expect(push?.paths?.some((p) => p.startsWith('docs/')), 'свой коммит справочника запускал бы прогон снова').toBe(false);
    // CLAUDE.md §8: планировщик GitHub душит очередь по числу расписаний.
    expect(wf.on?.schedule).toBeUndefined();
  });

  it('PostgreSQL той же мажорной версии, что у интеграционных тестов (ci.yml, kernel-pg)', () => {
    const ci = workflow('.github/workflows/ci.yml');
    const kernel = pgMajor(ci.jobs?.['kernel-pg']?.services?.postgres?.image);
    expect(kernel, 'в ci.yml не нашёлся postgres у kernel-pg').not.toBeNull();
    expect(pgMajor(job?.services?.postgres?.image)).toBe(kernel);
  });

  it('база собирается штатным путём: baseline → сброс отметок → migrate → снимок → коммит', () => {
    const order = [
      at(/node scripts\/bootstrap-from-baseline\.js/),
      at(/scripts\/schema-doc\.ts reset-after-baseline/),
      at(/^npm run migrate$/m),
      at(/^npm run db:schema-doc$/m),
      at(/git push origin HEAD:main/),
    ];
    expect(order.every((i) => i >= 0), `не найден шаг: ${order.join(', ')}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('тяжёлые шаги гейтятся тем же правилом свежести, что у сторожа', () => {
    const check = steps.find((s) => /scripts\/schema-doc\.ts check/.test(s.run ?? ''));
    expect(check?.id, 'у шага проверки свежести нет id — на него не сослаться').toBeTruthy();
    const gated = [
      at(/node scripts\/bootstrap-from-baseline\.js/),
      at(/scripts\/schema-doc\.ts reset-after-baseline/),
      at(/^npm run migrate$/m),
      at(/^npm run db:schema-doc$/m),
      at(/git push origin HEAD:main/),
    ];
    for (const i of gated) {
      expect(steps[i]?.if ?? '', `шаг «${steps[i]?.name}» не смотрит на итог проверки`).toContain(`steps.${check?.id}.outputs.stale`);
    }
  });

  it('коммит — в main, со [skip ci], с повтором при гонке', () => {
    const commit = steps[at(/git push origin HEAD:main/)]?.run ?? '';
    expect(commit).toMatch(/git commit -m "[^"]*\[skip ci\][^"]*"/);
    expect(commit, 'нет повтора: гонка с соседним мержем роняла бы снимок').toMatch(/for \w+ in /);
    expect(commit).toMatch(/git fetch origin main/);
    expect(commit).toMatch(/git reset --hard origin\/main/);
    expect(job?.permissions?.contents).toBe('write');
  });

  it('отказ — красный job с ::error::, а не тихий пропуск', () => {
    const onFailure = steps.find((s) => /failure\(\)/.test(s.if ?? ''));
    expect(onFailure?.run ?? '', 'нет шага, который при отказе говорит вслух').toMatch(/::error::/);
    expect(job?.['continue-on-error'], 'job, которому разрешено падать, отказ не покажет').toBeUndefined();
    for (const s of steps) {
      expect(s['continue-on-error'], `шаг «${s.name}» глушит отказ`).toBeUndefined();
      expect(s.run ?? '', `шаг «${s.name}» глушит отказ через || true`).not.toMatch(/\|\|\s*true/);
    }
    // Исчерпанные попытки пуша — тоже отказ, а не «не критично».
    expect(steps[at(/git push origin HEAD:main/)]?.run ?? '').toMatch(/::error::[\s\S]*exit 1/);
  });
});
