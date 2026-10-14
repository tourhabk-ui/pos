/**
 * Адрес по имени маршруту при записи (миграция 1237) — на настоящем PostgreSQL.
 *
 * Перепись sitemap 14.10: 133 маршрута из 370 открываются по UUID. Адреса
 * раздавали миграции разом, а пишущие пути их не выдавали — маршрут,
 * заведённый после бэкфилла, снова жил по UUID. 1237 заводит производителя:
 * правило `route_slug_candidate` и триггер на вставку и на «стал видимым».
 *
 * Правило держит сервер — уникальный индекс, видимость строк одной команды,
 * блокировку между транзакциями, — и статикой это не судится (прецедент 42P08
 * в CLAUDE.md). Поэтому здесь исполняется ФАЙЛ миграции, тем текстом, что
 * уйдёт на прод, и запрос переписи из lib/routes/slug-census — не копии.
 *
 * Что держит сторож:
 *  - добор по правилу 1136: свободный адрес выдан, тёзки — оба без адреса,
 *    имя места и чужой адрес не отданы, скрытый и слитый не тронуты;
 *    повторный прогон миграции не меняет ничего;
 *  - триггер: новый маршрут, ставший видимым, разлитый — с адресом; адрес
 *    писателя и смена названия адрес не трогают;
 *  - адреса разделов /routes/<раздел> (ROUTE_RESERVED_SLUGS) маршрут не
 *    получает: связка списка в SQL со списком в коде;
 *  - две вставки одного имени — в одной команде и в двух транзакциях — не
 *    роняют запись на уникальном индексе: адрес получает одна;
 *  - перепись называет держателя каждого адреса.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  ROUTE_RESERVED_SLUGS,
  ROUTE_SLUG_CENSUS_SQL,
  ROUTE_SLUG_SHADOWED_SQL,
  routeSlugHolder,
  type RouteSlugCensusRow,
} from '../../lib/routes/slug-census';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[route-slug-on-write] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

const SCHEMA = 'route_slug_on_write_test';
const MIGRATIONS = join(process.cwd(), 'migrations');
const MIGRATION = join(MIGRATIONS, '1237_route_slug_on_write.sql');

/** Номер миграции из имени файла: порядок числовой, не посимвольный (§7). */
const numberOf = (f: string) => Number(f.split('_')[0]);

/**
 * Действующее определение функции — из ПОСЛЕДНЕЙ по номеру миграции, которая
 * её задаёт. Иначе следующая правка правила (новый раздел, новое условие)
 * осталась бы непроверенной: сторож судил бы первую редакцию.
 */
function latestFunctionDdl(name: string): string {
  const head = `CREATE OR REPLACE FUNCTION ${name}(`;
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => numberOf(a) - numberOf(b));
  let ddl: string | null = null;
  for (const f of files) {
    const src = readFileSync(join(MIGRATIONS, f), 'utf-8');
    const at = src.indexOf(head);
    if (at < 0) continue;
    const open = src.indexOf('$$', at);
    const close = src.indexOf('$$', open + 2);
    const end = src.indexOf(';', close);
    if (open < 0 || close < 0 || end < 0) throw new Error(`${f}: определение ${name} не разобрано`);
    ddl = src.slice(at, end + 1);
  }
  if (!ddl) throw new Error(`ни одна миграция не задаёт ${name}`);
  return ddl;
}

const TABLES = `
  CREATE TABLE places (
    id text PRIMARY KEY,
    ark_id uuid DEFAULT gen_random_uuid(),
    name text,
    slug text,
    is_visible boolean NOT NULL DEFAULT true,
    merged_into_id text
  );
  CREATE UNIQUE INDEX places_slug_u ON places (slug) WHERE slug IS NOT NULL;
  CREATE TABLE kamchatka_routes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    slug text,
    is_visible boolean NOT NULL DEFAULT true,
    merged_into_id text,
    activity_type varchar,
    geometry jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX kamchatka_routes_slug_u ON kamchatka_routes (slug) WHERE slug IS NOT NULL;
`;

withPg('адрес по имени маршруту при записи (1237) на настоящем PostgreSQL', () => {
  let pool: Pool;

  async function routeId(title: string): Promise<string> {
    const r = await pool.query<{ id: string }>(`SELECT id::text AS id FROM kamchatka_routes WHERE title = $1`, [title]);
    if (r.rows.length !== 1) throw new Error(`маршрут «${title}»: строк ${r.rows.length}`);
    return r.rows[0].id;
  }

  async function slugsOf(title: string): Promise<(string | null)[]> {
    const r = await pool.query<{ slug: string | null }>(
      `SELECT slug FROM kamchatka_routes WHERE title = $1 ORDER BY slug NULLS LAST`, [title]);
    return r.rows.map((x) => x.slug);
  }

  async function insertRoute(title: string, extra: { slug?: string; visible?: boolean; mergedInto?: string } = {}) {
    await pool.query(
      `INSERT INTO kamchatka_routes (title, slug, is_visible, merged_into_id) VALUES ($1, $2, $3, $4)`,
      [title, extra.slug ?? null, extra.visible ?? true, extra.mergedInto ?? null],
    );
  }

  const runMigration = () => pool.query(readFileSync(MIGRATION, 'utf-8'));

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    // Схема — параметром соединения, а не `SET search_path`: пул раздаёт
    // разные соединения, и SET на одном не действует на другое.
    pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(TABLES);
    await pool.query(latestFunctionDdl('translit_ru_slug'));

    // Состояние ДО миграции: триггера ещё нет, адреса раздавал 1136.
    await pool.query(`INSERT INTO places (id, name, slug, is_visible) VALUES
      ('p-ksudach', 'Вулкан Ксудач', 'ksudach', true),
      ('p-nalychevo', 'Налычево', 'nalychevo', false)`);
    await insertRoute('Вулкан Горелый');
    await insertRoute('Озеро Голубое');
    await insertRoute('Озеро Голубое');
    await insertRoute('Медведи');
    await insertRoute('Ксудач');
    await insertRoute('Налычево');
    await insertRoute('Тайная тропа', { visible: false });
    await insertRoute('Мутновский', { slug: 'mutnovskij-svoj' });
    await insertRoute('Авача (старый)', { slug: 'avacha' });
    await insertRoute('Авача');
    await insertRoute('!!!');
    await insertRoute('Толбачик');
    await insertRoute('Толбачик (дубль)', { slug: 'tolbachik', mergedInto: await routeId('Толбачик') });
    await insertRoute('Карымский (скрытый)', { slug: 'karymskij', visible: false });
    await insertRoute('Карымский');
    await insertRoute('Рыбалка на Быстрой', { slug: 'rybalka' });
    await insertRoute('Слитый дубль', { mergedInto: await routeId('Вулкан Горелый') });

    await runMigration();
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool?.end();
  });

  describe('добор по правилу 1136', () => {
    it('свободный адрес выдан по имени', async () => {
      expect(await slugsOf('Вулкан Горелый')).toEqual(['vulkan-gorelyj']);
    });

    it('тёзки не делят адрес «кто первый» — оба остаются без адреса', async () => {
      expect(await slugsOf('Озеро Голубое')).toEqual([null, null]);
    });

    it('адрес места, чужой адрес, адрес раздела и пустое имя не выдаются', async () => {
      expect(await slugsOf('Ксудач')).toEqual([null]);
      expect(await slugsOf('Авача')).toEqual([null]);
      expect(await slugsOf('Медведи')).toEqual([null]);
      expect(await slugsOf('!!!')).toEqual([null]);
    });

    it('скрытый и слитый не тронуты, адрес писателя не переписан', async () => {
      expect(await slugsOf('Тайная тропа')).toEqual([null]);
      expect(await slugsOf('Слитый дубль')).toEqual([null]);
      expect(await slugsOf('Мутновский')).toEqual(['mutnovskij-svoj']);
    });

    it('повторный прогон миграции не меняет ничего', async () => {
      const before = await pool.query(`SELECT id, slug, updated_at FROM kamchatka_routes ORDER BY id`);
      await runMigration();
      const after = await pool.query(`SELECT id, slug, updated_at FROM kamchatka_routes ORDER BY id`);
      expect(after.rows).toEqual(before.rows);
    });
  });

  describe('перепись называет держателя адреса', () => {
    it('исход у каждого маршрута без адреса — по имени держателя', async () => {
      const { rows } = await pool.query<RouteSlugCensusRow>(ROUTE_SLUG_CENSUS_SQL, [[...ROUTE_RESERVED_SLUGS]]);
      const holders = rows.map((r) => [r.title, routeSlugHolder(r)]).sort();
      expect(holders).toEqual([
        ['!!!', 'empty_base'],
        ['Авача', 'visible_route'],
        ['Карымский', 'hidden_route'],
        ['Ксудач', 'visible_place'],
        ['Медведи', 'section'],
        ['Налычево', 'hidden_place'],
        ['Озеро Голубое', 'namesake'],
        ['Озеро Голубое', 'namesake'],
        ['Толбачик', 'merged_into_this'],
      ]);
      // Правило выдало всё, что могло: выдать сейчас нечего никому.
      expect(rows.every((r) => r.would_assign === null)).toBe(true);
    });

    it('маршрут с адресом раздела назван: его карточку перекрывает раздел', async () => {
      const { rows } = await pool.query<{ title: string; slug: string }>(ROUTE_SLUG_SHADOWED_SQL, [[...ROUTE_RESERVED_SLUGS]]);
      expect(rows.map((r) => [r.title, r.slug])).toEqual([['Рыбалка на Быстрой', 'rybalka']]);
    });
  });

  describe('триггер: адрес при записи', () => {
    it('новый видимый маршрут получает адрес по имени', async () => {
      await insertRoute('Долина гейзеров');
      expect(await slugsOf('Долина гейзеров')).toEqual(['dolina-gejzerov']);
    });

    it('скрытый — без адреса, пока не станет видимым', async () => {
      await insertRoute('Курильское озеро', { visible: false });
      expect(await slugsOf('Курильское озеро')).toEqual([null]);
      await pool.query(`UPDATE kamchatka_routes SET is_visible = TRUE WHERE title = 'Курильское озеро'`);
      expect(await slugsOf('Курильское озеро')).toEqual(['kurilskoe-ozero']);
    });

    it('разлитый маршрут получает адрес', async () => {
      await insertRoute('Мыс Маячный', { mergedInto: await routeId('Долина гейзеров') });
      expect(await slugsOf('Мыс Маячный')).toEqual([null]);
      await pool.query(`UPDATE kamchatka_routes SET merged_into_id = NULL WHERE title = 'Мыс Маячный'`);
      expect(await slugsOf('Мыс Маячный')).toEqual(['mys-mayachnyj']);
    });

    it('адрес писателя не трогается, смена названия адрес не меняет', async () => {
      await insertRoute('Вилючинский', { slug: 'vilyuchik-svoj' });
      expect(await slugsOf('Вилючинский')).toEqual(['vilyuchik-svoj']);
      await pool.query(`UPDATE kamchatka_routes SET title = 'Долина гейзеров (пешком)' WHERE title = 'Долина гейзеров'`);
      expect(await slugsOf('Долина гейзеров (пешком)')).toEqual(['dolina-gejzerov']);
    });

    it('адрес занят — новый тёзка остаётся без адреса, вставка не падает', async () => {
      await insertRoute('Вулкан Горелый');
      expect(await slugsOf('Вулкан Горелый')).toEqual(['vulkan-gorelyj', null]);
    });

    it('адреса разделов маршрут не получает — ни один из списка в коде', async () => {
      // Держатель адреса раздела отказал бы и без правила разделов — убираем
      // его, чтобы отказ доказывал именно правило.
      await pool.query(`DELETE FROM kamchatka_routes WHERE slug = ANY($1::text[])`, [[...ROUTE_RESERVED_SLUGS]]);
      let checked = 0;
      for (const word of ROUTE_RESERVED_SLUGS) {
        const { rows } = await pool.query<{ base: string }>(`SELECT translit_ru_slug($1) AS base`, [word]);
        // «termalnye_istochniki»: подчёркивания транслитерация не даёт — такой
        // адрес правило не выдаст ни при каком имени.
        if (rows[0].base !== word) continue;
        // Латинское имя транслитерация оставляет как есть: адрес совпал бы с разделом.
        await insertRoute(word);
        expect({ word, slugs: await slugsOf(word) }).toEqual({ word, slugs: [null] });
        checked += 1;
      }
      // Ноль проверенных при непустом списке — отказ сторожа, а не «нарушений нет» (§4.0).
      expect(checked).toBeGreaterThan(8);
    });

    it('двое тёзок одной вставкой: адрес у одного, вставка не падает', async () => {
      await pool.query(`INSERT INTO kamchatka_routes (title) VALUES ('Река Камчатка'), ('Река Камчатка')`);
      expect(await slugsOf('Река Камчатка')).toEqual(['reka-kamchatka', null]);
    });

    it('двое тёзок в двух транзакциях: вторая ждёт первую и не падает на уникальном индексе', async () => {
      const t1 = await pool.connect();
      const t2 = await pool.connect();
      try {
        await t1.query('BEGIN');
        await t2.query('BEGIN');
        await t1.query(`INSERT INTO kamchatka_routes (title) VALUES ('Халактырский пляж')`);
        let secondDone = false;
        const second = t2
          .query(`INSERT INTO kamchatka_routes (title) VALUES ('Халактырский пляж')`)
          .then(() => { secondDone = true; });
        await new Promise((r) => setTimeout(r, 300));
        // Вторая вставка стоит на блокировке адреса, пока первая не решится.
        expect(secondDone).toBe(false);
        await t1.query('COMMIT');
        await second;
        await t2.query('COMMIT');
      } finally {
        // На провале транзакции остаются открытыми — в пул их возвращать нельзя.
        await t1.query('ROLLBACK').catch(() => undefined);
        await t2.query('ROLLBACK').catch(() => undefined);
        t1.release();
        t2.release();
      }
      expect(await slugsOf('Халактырский пляж')).toEqual(['halaktyrskij-plyazh', null]);
    });
  });
});
