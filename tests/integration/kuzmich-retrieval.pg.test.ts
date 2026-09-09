/**
 * Поиск мест Кузьмича — доказательство ВЫПОЛНЕНИЕМ, а не чтением.
 *
 * Упрёк к прежнему коду был именно такой: запрос не выполнялся НИКОГДА.
 * `to_tsvector('russian', search_text)` при `search_text` типа `tsvector` —
 * это 42883 на каждом вызове, а пустой `catch` превращал отказ в «мест не
 * нашлось». Полтора месяца Кузьмич отвечал про безопасность по памяти модели.
 *
 * Такое доказывается только настоящим PostgreSQL: разрешение типов делает
 * сервер, и прецедент 42P08 в CLAUDE.md ровно об этом. Поэтому здесь берётся
 * SQL ИЗ ИСХОДНИКА (не копия: копия разошлась бы с оригиналом и охраняла бы
 * саму себя) и исполняется — вместе с миграцией 942, которая даёт колонке
 * содержание.
 *
 * Тест держит обе стороны: новая форма находит место, старая — падает. Без
 * второй половины «зелено» не значило бы, что дефект был.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn(
    '[kuzmich-retrieval] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)',
  );
}

const CORE = join(process.cwd(), 'lib/kuzmich/core.ts');
const MIGRATION = join(process.cwd(), 'migrations/942_agent_route_knowledge_search_text.sql');

/**
 * Достаёт из core.ts тот самый запрос, что уйдёт в прод.
 *
 * Привязка структурная — от объявления `pool.query<PlaceRow>`, — а не по
 * первому попавшемуся SELECT: выше в файле лежит системный промпт, где те же
 * слова стоят прозой.
 */
function liveSearchSql(): string {
  const src = readFileSync(CORE, 'utf8');
  const at = src.indexOf('await pool.query<PlaceRow>(');
  if (at < 0) throw new Error('в core.ts не найден запрос поиска мест');
  const open = src.indexOf('`', at);
  const close = src.indexOf('`', open + 1);
  if (open < 0 || close < 0) throw new Error('запрос поиска мест не в шаблонной строке');
  const sql = src.slice(open + 1, close);
  // Единственная подстановка в шаблоне — константа RRF.
  return sql.replace(/\$\{RRF_K\}/g, '60');
}

/** Тело миграции без строки учёта: таблицы _migrations в тестовой базе нет. */
function migrationSql(): string {
  return readFileSync(MIGRATION, 'utf8')
    .replace(/INSERT INTO _migrations[\s\S]*?;\s*$/m, '');
}

/**
 * Минимальная схема под представление — В СВОЕЙ СХЕМЕ БД.
 *
 * Не в public намеренно: CI гоняет все *.pg.test.ts в одной базе, а
 * `transfers.pg.test.ts` тоже работает с `places`. `DROP TABLE places` в
 * общем пространстве сделал бы соседний тест заложником порядка запуска —
 * то есть красным через раз и по чужой вине.
 *
 * Схема задаётся ПАРАМЕТРОМ СОЕДИНЕНИЯ, а не `SET search_path` в сессии.
 * Первая версия делала второе и упала в CI: после ожидаемой ошибки 42883 пул
 * выдал другое соединение, `search_path` на нём был по умолчанию, и следующий
 * запрос не нашёл представления. Локально то же самое прошло по удаче —
 * ровно тот случай, когда «у меня работает» ничего не значит.
 *
 * Только те колонки, которые представление действительно называет. `embedding`
 * объявлен текстом намеренно: представление его лишь пробрасывает, а тянуть
 * ради этого расширение pgvector в тестовую базу — лишняя зависимость.
 */
const TEST_SCHEMA = 'kuz_retrieval_test';

const SCHEMA = `
  DROP VIEW IF EXISTS agent_route_knowledge;
  DROP VIEW IF EXISTS v_kamchatka_routes_api;
  DROP TABLE IF EXISTS places;
  DROP TABLE IF EXISTS kamchatka_routes;

  CREATE TABLE places (
    id TEXT PRIMARY KEY,
    ark_id UUID,
    category TEXT,
    name TEXT NOT NULL,
    description TEXT,
    lat NUMERIC,
    lng NUMERIC,
    source_url TEXT,
    source_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_visible BOOLEAN DEFAULT TRUE,
    location_type VARCHAR(64),
    activity_type TEXT,
    zone TEXT,
    search_count INT DEFAULT 0,
    embedding TEXT,
    merged_into_id TEXT
  );

  CREATE TABLE kamchatka_routes (
    id UUID PRIMARY KEY,
    ark_id UUID,
    dedupe_key TEXT,
    category TEXT,
    title TEXT NOT NULL,
    description TEXT,
    lat NUMERIC,
    lng NUMERIC,
    source_url TEXT,
    source_name TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_visible BOOLEAN DEFAULT TRUE,
    activity_type TEXT,
    zone TEXT,
    search_count INT DEFAULT 0,
    embedding TEXT,
    merged_into_id TEXT
  );

  CREATE VIEW v_kamchatka_routes_api AS
    SELECT title, description, source_name FROM kamchatka_routes
     WHERE is_visible = TRUE AND merged_into_id IS NULL;
`;

const SEED = `
  INSERT INTO places (id, ark_id, name, description, lat, lng, location_type, source_name)
  VALUES ('p1', gen_random_uuid(), 'Вулкан Мутновский',
          'Действующий вулкан с фумарольными полями и кислотными озёрами в кратере.',
          52.448701, 158.194196, 'volcano', 'справочник');

  INSERT INTO kamchatka_routes (id, title, description, activity_type)
  VALUES (gen_random_uuid(), 'Восхождение на вулкан Мутновский',
          'Подъём к кратеру действующего вулкана.', 'trekking');
`;

withPg('поиск мест Кузьмича на настоящем PostgreSQL', () => {
  let pool: Pool;

  beforeAll(async () => {
    // Схему заводим отдельным соединением: указать её в параметрах можно
    // только после того, как она существует.
    const bootstrap = new Pool({ connectionString: PG_URL });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await bootstrap.end();

    // `options` применяется к КАЖДОМУ соединению пула — в отличие от
    // `SET search_path`, который живёт лишь до смены соединения.
    pool = new Pool({
      connectionString: PG_URL,
      options: `-c search_path=${TEST_SCHEMA}`,
    });
    await pool.query(SCHEMA);
    await pool.query(migrationSql());
    await pool.query(SEED);
  }, 60_000);

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await pool?.end();
  });

  it('миграция 942 применяется и даёт search_text содержание', async () => {
    const { rows } = await pool.query<{ empty: boolean }>(
      `SELECT search_text IS NULL OR search_text = ''::tsvector AS empty
         FROM agent_route_knowledge WHERE title = 'Вулкан Мутновский'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].empty, 'search_text снова пуст — колонка не держит обещания имени')
      .toBe(false);
  });

  it('ЖИВОЙ запрос из core.ts выполняется и находит место', async () => {
    const { rows } = await pool.query<{ title: string }>(liveSearchSql(), ['мутновский']);
    expect(rows.map((r) => r.title)).toContain('Вулкан Мутновский');
  });

  it('прежняя форма запроса падает 42883 — дефект был, а не привиделся', async () => {
    await expect(
      pool.query(
        `SELECT title FROM agent_route_knowledge
          WHERE to_tsvector('russian', search_text) @@ plainto_tsquery('russian', $1)`,
        ['мутновский'],
      ),
    ).rejects.toMatchObject({ code: '42883' });
  });

  it('запрос без совпадений возвращает пусто, а не падает', async () => {
    const { rows } = await pool.query(liveSearchSql(), ['такогоместанебывает']);
    expect(rows).toHaveLength(0);
  });
});
