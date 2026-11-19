/**
 * Поиск мест Кузьмича — доказательство ВЫПОЛНЕНИЕМ, а не чтением.
 * Вторая часть файла — заметки Кузьмича только с источником (#3514).
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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { KUZMICH_KNOWLEDGE_SCOPE_SQL } from '@/lib/kuzmich/knowledge-scope';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import { placeInfoForKuzmich } from '@/lib/kuzmich/place-info-tool';
import { getGuardianContextDetailed } from '@/lib/kuzmich/guardian-context';

const appDb = vi.hoisted(() => ({
  pool: null as null | { query: (sql: string, params?: unknown[]) => Promise<unknown> },
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => appDb.pool!.query(sql, params) },
}));

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

/**
 * ── Вторая часть файла ──
 *
 * Заметки Кузьмича о местах уходят к человеку только с источником (#3514,
 * слово владельца 19.11 «1 поменять ответ из источников»).
 *
 * Мир теста — настоящие файлы миграций: 141 (place/faq/transport без
 * источника), 669 (двадцать «традиционных знаний» с пометкой seed_indigenous),
 * 1377 (расстояния сверены) и 1462 (две записи переписаны фактами из
 * источника). Снимок схемы данных не несёт, поэтому записи 141 и 669 здесь
 * заводит их собственный SQL, а не подложенные строки.
 *
 * Судятся не тексты запросов, а то, что получает человек: область на
 * настоящем PostgreSQL, справка о месте (get_place_info) и ответ стража
 * (get_guardian_context) — вызовом.
 */
const SOURCED_TEST_DB = 'kuzmich_knowledge_sourced_test';
const migrationFile = (name: string) => readFileSync(join(process.cwd(), 'migrations', name), 'utf-8');

withPg('заметки Кузьмича — только с источником (#3514)', () => {
  let pool: Pool;

  beforeAll(async () => {
    const dbUrl = await createTestDatabase(PG_URL, SOURCED_TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    appDb.pool = pool;
    await pool.query(`DELETE FROM agent_knowledge`);
    for (const f of [
      '141_kuzmich_agent_knowledge.sql',
      '669_indigenous_knowledge_seed.sql',
      '1377_kuzmich_knowledge_distances.sql',
    ]) {
      await pool.query(migrationFile(f));
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (PG_URL) await dropTestDatabase(PG_URL, SOURCED_TEST_DB);
  });

  const scoped = async () => (await pool.query<{ slug: string }>(
    `SELECT slug FROM agent_knowledge WHERE ${KUZMICH_KNOWLEDGE_SCOPE_SQL} ORDER BY slug`,
  )).rows.map((r) => r.slug);

  it('до 1462: в базе 30 курируемых записей, и ни одна не проходит — у них нет источника', async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM agent_knowledge
        WHERE agent_id = 'kuzmich' AND type IN ('place', 'faq', 'transport', 'indigenous')`,
    );
    expect(rows[0].n).toBe(30);
    expect(await scoped()).toEqual([]);
  });

  it('пометка «seed_indigenous» и адрес без схемы источником не считаются', async () => {
    await pool.query(
      `INSERT INTO agent_knowledge (slug, type, title, compiled_truth, agent_id, metadata) VALUES
         ('t-no-scheme', 'place', 'Тест без схемы', 'текст', 'kuzmich', '{"source_url":"paratunka-sp.ru"}'),
         ('t-blank', 'place', 'Тест пустой', 'текст', 'kuzmich', '{"source_url":"   "}'),
         ('t-with-space', 'place', 'Тест пробел', 'текст', 'kuzmich', '{"source_url":"https://a.ru/ b"}'),
         ('t-ok-other-agent', 'place', 'Тест чужой агент', 'текст', 'scout', '{"source_url":"https://a.ru/x"}'),
         ('t-ok-search', 'search_result', 'Тест поиск', 'текст', 'kuzmich', '{"source_url":"https://a.ru/x"}')`,
    );
    expect(await scoped()).toEqual([]);
    await pool.query(`DELETE FROM agent_knowledge WHERE slug LIKE 't-%'`);
  });

  it('1462 переписывает две записи фактами из источника, остальные 28 не трогает', async () => {
    const before = await pool.query<{ slug: string; compiled_truth: string }>(
      `SELECT slug, compiled_truth FROM agent_knowledge ORDER BY slug`,
    );
    await pool.query(migrationFile('1462_kuzmich_notes_sourced.sql'));
    expect(await scoped()).toEqual(['malkinskie-springs', 'paratunka-thermal']);

    const after = await pool.query<{ slug: string; compiled_truth: string; metadata: Record<string, unknown> }>(
      `SELECT slug, compiled_truth, metadata FROM agent_knowledge ORDER BY slug`,
    );
    const was = new Map(before.rows.map((r) => [r.slug, r.compiled_truth]));
    for (const r of after.rows) {
      if (r.slug === 'paratunka-thermal' || r.slug === 'malkinskie-springs') {
        // Прежний текст сохранён — вернуть можно по одной записи.
        expect(r.metadata.withdrawn_truth).toBe(was.get(r.slug));
        // Ни цены, ни автобуса: в источниках 1377 их не сверяли.
        expect(r.compiled_truth).not.toMatch(/автобус|р\.|₽|руб/);
      } else {
        expect(r.compiled_truth, r.slug).toBe(was.get(r.slug));
      }
    }
    const paratunka = after.rows.find((r) => r.slug === 'paratunka-thermal');
    expect(paratunka?.compiled_truth).toContain('60 км');
    expect(paratunka?.compiled_truth).toContain('paratunka-sp.ru');

    // Повтор миграции ничего не меняет: withdrawn_truth не затирается новым текстом.
    await pool.query(migrationFile('1462_kuzmich_notes_sourced.sql'));
    const again = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM agent_knowledge WHERE slug = 'paratunka-thermal'`,
    );
    expect(again.rows[0].metadata.withdrawn_truth).toBe(was.get('paratunka-thermal'));
  });

  it('get_place_info: о Курильском озере — ни «Камбальным», ни цены вертолёта; о Паратунке — заметка с источником', async () => {
    const kuril = await placeInfoForKuzmich('Курильское озеро');
    expect(kuril ?? '').not.toContain('Камбальным');
    expect(kuril ?? '').not.toContain('Заметка Кузьмича');
    expect(kuril ?? '').not.toContain('25 000');

    const paratunka = await placeInfoForKuzmich('Паратунка');
    expect(paratunka).toContain('Заметка Кузьмича «Паратунка — сколько ехать от Петропавловска»');
    expect(paratunka).toContain('paratunka-sp.ru');
    expect(paratunka).not.toContain('№111');
  });

  it('get_guardian_context: без «традиционных знаний» без источника; с источником — заметка в ответе', async () => {
    const koryak = await getGuardianContextDetailed('Корякский вулкан');
    expect(koryak.text).not.toContain('Кухх');
    expect(koryak.text).not.toContain('[Традиционные знания]');

    const malki = await getGuardianContextDetailed('Малкинские источники');
    expect(malki.text).toContain('130 км');
    expect(malki.text).toContain('topkam.ru');
    expect(malki.text).not.toContain('3000');
  });
});
