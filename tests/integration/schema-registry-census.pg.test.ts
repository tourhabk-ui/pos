/**
 * Перепись реестра схемы: живость и отсутствие — на настоящем PostgreSQL.
 *
 * Запрос переписи спрашивает сервер о том, что сервер решает сам: существует ли
 * таблица (`information_schema.tables`), есть ли в ней хоть одна строка
 * (`query_to_xml` вокруг `count(*)` подзапроса с LIMIT 1) и как экранируется её
 * имя (`format('%I')`). Ни одно из трёх статикой не судится — прецедент 42P08 в
 * CLAUDE.md ровно об этом: вывод типов и разрешение имён делает сервер, а не
 * читатель исходника.
 *
 * Мокнутая база в юнит-стороже доказывает РАСКЛАДКУ ответа (что '1' станет
 * `present_with_rows`, а отказ — `unknown`). Она не может доказать, что сервер
 * вообще вернёт '1' на живой таблице и '0' на пустой. Это доказывается здесь.
 *
 * SQL берётся ИЗ ИСХОДНИКА роута, а не копией: копия разошлась бы с оригиналом
 * и охраняла бы саму себя.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[schema-registry-census] KERNEL_PG_TEST_URL не задан — тест пропущен (не прогнан, а не зелёный)',
  );
}

const ROUTE = join(process.cwd(), 'app/api/cron/schema-registry-census/route.ts');

/**
 * Достаёт запрос состояния из `inspectAll` — именно тот, что уйдёт в прод.
 *
 * Привязка структурная, от объявления функции: искать первый попавшийся SQL в
 * бэктиках нельзя, комментарии в этом файле обсуждают запросы дословно.
 */
function inspectQueryFromRoute(): string {
  const src = readFileSync(ROUTE, 'utf8');
  const at = src.indexOf('async function inspectAll');
  if (at === -1) throw new Error('в schema-registry-census/route.ts не найдена inspectAll');
  const m = /`([\s\S]*?)`/.exec(src.slice(at));
  if (!m) throw new Error('внутри inspectAll не найден SQL в бэктиках');
  return m[1];
}

withPg('перепись реестра схемы на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  const ALIVE = 'census_probe_alive';
  const EMPTY = 'census_probe_empty';
  const ABSENT = 'census_probe_absent';
  // Имя, которое конкатенация в TS сломала бы: без кавычек PostgreSQL сложил бы
  // его в нижний регистр и не нашёл таблицу. Ради этого случая и стоит %I.
  const MIXED = 'CensusProbeMixed';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    await pool.query(`CREATE TABLE IF NOT EXISTS ${ALIVE} (id int)`);
    await pool.query(`INSERT INTO ${ALIVE} (id) VALUES (1), (2)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${EMPTY} (id int)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS "${MIXED}" (id int)`);
    await pool.query(`INSERT INTO "${MIXED}" (id) VALUES (1)`);
  });

  afterAll(async () => {
    for (const t of [`${ALIVE}`, `${EMPTY}`, `"${MIXED}"`]) {
      await pool.query(`DROP TABLE IF EXISTS ${t}`).catch(() => undefined);
    }
    await pool.end();
  });

  it('различает живую, пустую и отсутствующую таблицу', async () => {
    const { rows } = await pool.query<{ table_name: string; any_row: string | null }>(
      inspectQueryFromRoute(),
      [[ALIVE, EMPTY, ABSENT]],
    );
    const got = new Map(rows.map((r) => [r.table_name, r.any_row]));

    expect(got.get(ALIVE), 'в таблице есть строки — сервер обязан сказать 1').toBe('1');
    expect(got.get(EMPTY), 'таблица есть, но пуста — 0, а не отсутствие').toBe('0');
    // Несуществующая не возвращается вовсе: именно по этому роут и объявляет её
    // `absent`. Если бы сервер отдавал её со значением NULL, «нет таблицы» и
    // «пустая» слились бы в одно.
    expect(got.has(ABSENT), 'отсутствующей таблицы в ответе быть не должно').toBe(false);
  });

  it('имя таблицы экранируется сервером — регистр не теряется', async () => {
    const { rows } = await pool.query<{ table_name: string; any_row: string | null }>(
      inspectQueryFromRoute(),
      [[MIXED]],
    );
    // Собранное конкатенацией `FROM public.CensusProbeMixed` упало бы на
    // «relation does not exist»: PostgreSQL свернул бы имя в нижний регистр.
    expect(rows).toHaveLength(1);
    expect(rows[0].any_row).toBe('1');
  });

  it('живость спрашивается одной строкой, а не полным счётом', () => {
    // Тридцать `count(*)` — тридцать сканирований ради ответа «да/нет».
    expect(inspectQueryFromRoute()).toContain('LIMIT 1');
  });
});
