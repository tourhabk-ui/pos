/**
 * Адрес по имени маршруту при записи (миграции 1237, 1239, 1242) — на
 * настоящем PostgreSQL.
 *
 * Перепись sitemap 14.10: 133 маршрута из 370 открываются по UUID. Адреса
 * раздавали миграции разом, а пишущие пути их не выдавали — маршрут,
 * заведённый после бэкфилла, снова жил по UUID. 1237 заводит производителя:
 * правило `route_slug_candidate` и триггер на вставку и на «стал видимым».
 * Перепись на проде после 1237 показала, что у всех 133 адрес держит место
 * или скрытый маршрут-тёзка; 1239 по решению владельца 14.10 даёт маршруту к
 * месту `<имя>-marshrut` и переносит адрес скрытого тёзки видимому. Перепись
 * после 1239 оставила одного — «Зеленовские озерки»: суффикс держал скрытый
 * тёзка (его выдала 1112); 1242 переносит видимому и суффиксный адрес.
 *
 * Правило держит сервер — уникальный индекс, видимость строк одной команды,
 * блокировку между транзакциями, — и статикой это не судится (прецедент 42P08
 * в CLAUDE.md). Поэтому здесь исполняется ФАЙЛ миграции, тем текстом, что
 * уйдёт на прод, и запрос переписи из lib/routes/slug-census — не копии.
 *
 * Что держит сторож:
 *  - добор: свободный адрес выдан, тёзки — оба без адреса (и без суффикса),
 *    адрес, занятый местом (видимым, скрытым, слитым), — с суффиксом
 *    `-marshrut`, если тот свободен; адрес чужого видимого маршрута не
 *    отдан; адрес скрытого тёзки перешёл видимому — и по имени, и с
 *    суффиксом; суффикс скрытого НЕ тёзки, слитого держателя и при двух
 *    видимых претендентах не тронут; скрытый и слитый маршрут не тронуты;
 *    повторный прогон миграций не меняет ничего;
 *  - триггер: новый маршрут, ставший видимым, разлитый — с адресом; адрес
 *    писателя и смена названия адрес не трогают;
 *  - адреса разделов /routes/<раздел> (ROUTE_RESERVED_SLUGS) маршрут не
 *    получает: связка списка в SQL со списком в коде;
 *  - две вставки одного имени — в одной команде и в двух транзакциях — не
 *    роняют запись на уникальном индексе: адрес получает одна; так же
 *    маршрут к месту X и маршрут «X маршрут» не делят `x-marshrut`;
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
import { MERGED_ROUTE_SQL } from '../../lib/routes/resolve-route-ref';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[route-slug-on-write] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

const SCHEMA = 'route_slug_on_write_test';
const MIGRATIONS = join(process.cwd(), 'migrations');
/** Миграции правила адреса — в порядке наката, как на деплое. */
const RULE_MIGRATIONS = [
  '1237_route_slug_on_write.sql',
  '1239_route_marshrut_and_hidden_twin.sql',
  '1242_route_suffix_from_hidden_twin.sql',
];

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
    merged_into_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
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

withPg('адрес по имени маршруту при записи (1237, 1239, 1242) на настоящем PostgreSQL', () => {
  let pool: Pool;

  async function routeId(title: string): Promise<string> {
    const r = await pool.query<{ id: string }>(`SELECT id::text AS id FROM kamchatka_routes WHERE title = $1`, [title]);
    if (r.rows.length !== 1) throw new Error(`маршрут «${title}»: строк ${r.rows.length}`);
    return r.rows[0].id;
  }

  /** Адреса тёзок по видимости: [видимые…, скрытые…]. */
  async function slugsByVisibility(title: string): Promise<{ visible: (string | null)[]; hidden: (string | null)[] }> {
    const r = await pool.query<{ slug: string | null; is_visible: boolean }>(
      `SELECT slug, is_visible FROM kamchatka_routes WHERE title = $1 ORDER BY slug NULLS LAST`, [title]);
    return {
      visible: r.rows.filter((x) => x.is_visible).map((x) => x.slug),
      hidden: r.rows.filter((x) => !x.is_visible).map((x) => x.slug),
    };
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

  async function runMigrations() {
    for (const f of RULE_MIGRATIONS) await pool.query(readFileSync(join(MIGRATIONS, f), 'utf-8'));
  }

  /** Две вставки в двух транзакциях; вторая обязана ждать первую, а не падать. */
  async function insertConcurrently(first: string, second: string) {
    const t1 = await pool.connect();
    const t2 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t2.query('BEGIN');
      await t1.query(`INSERT INTO kamchatka_routes (title) VALUES ($1)`, [first]);
      let secondDone = false;
      const pending = t2
        .query(`INSERT INTO kamchatka_routes (title) VALUES ($1)`, [second])
        .then(() => { secondDone = true; });
      await new Promise((r) => setTimeout(r, 300));
      // Вторая вставка стоит на блокировке адреса, пока первая не решится.
      expect(secondDone).toBe(false);
      await t1.query('COMMIT');
      await pending;
      await t2.query('COMMIT');
    } finally {
      // На провале транзакции остаются открытыми — в пул их возвращать нельзя.
      await t1.query('ROLLBACK').catch(() => undefined);
      await t2.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
  }

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

    // Состояние ДО миграций: триггера ещё нет, адреса раздавал 1136.
    await pool.query(`INSERT INTO places (id, name, slug, is_visible, merged_into_id) VALUES
      ('p-ksudach', 'Вулкан Ксудач', 'ksudach', true, NULL),
      ('p-nalychevo', 'Налычево', 'nalychevo', false, NULL),
      ('p-kamen', 'Вулкан Камень', 'vulkan-kamen', true, 'p-ksudach'),
      ('p-dalnee', 'Озеро Дальнее', 'ozero-dalnee', true, NULL),
      ('p-lopatka', 'Мыс Лопатка', 'mys-lopatka', true, NULL),
      ('p-russkaya', 'Бухта Русская', 'buhta-russkaya', true, NULL),
      ('p-shlyupochnaya', 'Бухта Шлюпочная', 'buhta-shlyupochnaya', true, NULL),
      ('p-zelenovskie', 'Зеленовские озерки', 'zelenovskie-ozerki', true, NULL),
      ('p-tihaya', 'Бухта Тихая', 'buhta-tihaya', true, NULL),
      ('p-kruglenkoe', 'Озеро Кругленькое', 'ozero-kruglenkoe', true, NULL),
      ('p-bakening', 'Вулкан Бакенинг', 'vulkan-bakening', true, NULL),
      ('p-medvezhe', 'Озеро Медвежье', 'ozero-medvezhe', true, NULL),
      ('p-mishennaya', 'Сопка Мишенная', 'sopka-mishennaya', true, NULL),
      ('p-mishennaya-m', 'Сопка Мишенная маршрут', 'sopka-mishennaya-marshrut', true, NULL)`);
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
    await insertRoute('Вулкан Камень');
    await insertRoute('Озеро Дальнее');
    await insertRoute('Озеро Дальнее');
    // Суффиксный адрес у места уже занят — как у «Зеленовских озерков» на проде.
    await insertRoute('Мыс Лопатка (старый путь)', { slug: 'mys-lopatka-marshrut' });
    await insertRoute('Мыс Лопатка');
    // Как «Зеленовские озерки» на проде: адрес по имени у места, суффикс —
    // у СКРЫТОГО тёзки (его выдала 1112, когда тёзка держал имя).
    await insertRoute('Зеленовские озерки', { slug: 'zelenovskie-ozerki-marshrut', visible: false });
    await insertRoute('Зеленовские озерки');
    // Суффикс у скрытого, но НЕ тёзки — чужой маршрут, его адрес не отдаётся.
    await insertRoute('Бухта Тихая (старый подход)', { slug: 'buhta-tihaya-marshrut', visible: false });
    await insertRoute('Бухта Тихая');
    // Суффикс у слитого тёзки — о слитых решения нет, не трогается.
    await insertRoute('Озеро Кругленькое', { slug: 'ozero-kruglenkoe-marshrut', visible: false, mergedInto: await routeId('Вулкан Горелый') });
    await insertRoute('Озеро Кругленькое');
    // Суффикс у скрытого тёзки, но видимых претендентов двое — не «кто первый».
    await insertRoute('Вулкан Бакенинг', { slug: 'vulkan-bakening-marshrut', visible: false });
    await insertRoute('Вулкан Бакенинг');
    await insertRoute('Вулкан Бакенинг');
    // Суффикс у ВИДИМОГО тёзки — дубль, о нём решения нет: адрес не отнимается.
    await insertRoute('Озеро Медвежье', { slug: 'ozero-medvezhe-marshrut' });
    await insertRoute('Озеро Медвежье');
    // Адрес по имени держит видимый МАРШРУТ, а не место — суффикс скрытого
    // тёзки не переходит: такой маршрут — дубль, а не путь к месту.
    await insertRoute('Жупановский (старый)', { slug: 'vulkan-zhupanovskij' });
    await insertRoute('Вулкан Жупановский', { slug: 'vulkan-zhupanovskij-marshrut', visible: false });
    await insertRoute('Вулкан Жупановский');
    // Суффикс держат и место, и скрытый тёзка (уникальности между таблицами
    // нет): маршрут с адресом места ушёл бы редиректом двойника к месту.
    await insertRoute('Сопка Мишенная', { slug: 'sopka-mishennaya-marshrut', visible: false });
    await insertRoute('Сопка Мишенная');

    await runMigrations();
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool?.end();
  });

  describe('добор по правилу 1237, 1239', () => {
    it('свободный адрес выдан по имени', async () => {
      expect(await slugsOf('Вулкан Горелый')).toEqual(['vulkan-gorelyj']);
    });

    it('тёзки не делят адрес «кто первый» — оба остаются без адреса', async () => {
      expect(await slugsOf('Озеро Голубое')).toEqual([null, null]);
    });

    it('адрес держит место — маршрут к нему получает <имя>-marshrut: видимое, скрытое, слитое', async () => {
      expect(await slugsOf('Ксудач')).toEqual(['ksudach-marshrut']);
      expect(await slugsOf('Налычево')).toEqual(['nalychevo-marshrut']);
      expect(await slugsOf('Вулкан Камень')).toEqual(['vulkan-kamen-marshrut']);
    });

    it('суффикс занят или тёзки — без адреса; чужой видимый адрес, раздел и пустое имя не выдаются', async () => {
      expect(await slugsOf('Мыс Лопатка')).toEqual([null]);
      expect(await slugsOf('Озеро Дальнее')).toEqual([null, null]);
      expect(await slugsOf('Авача')).toEqual([null]);
      expect(await slugsOf('Медведи')).toEqual([null]);
      expect(await slugsOf('!!!')).toEqual([null]);
    });

    it('адрес скрытого тёзки перешёл видимому, скрытый остался без адреса', async () => {
      expect(await slugsOf('Карымский')).toEqual(['karymskij']);
      expect(await slugsOf('Карымский (скрытый)')).toEqual([null]);
    });

    it('суффикс скрытого тёзки перешёл видимому (1242), скрытый остался без адреса', async () => {
      expect(await slugsByVisibility('Зеленовские озерки')).toEqual({
        visible: ['zelenovskie-ozerki-marshrut'], hidden: [null],
      });
    });

    it('суффикс не тёзки, слитого держателя и при двух претендентах — не тронут', async () => {
      expect(await slugsOf('Бухта Тихая')).toEqual([null]);
      expect(await slugsOf('Бухта Тихая (старый подход)')).toEqual(['buhta-tihaya-marshrut']);
      expect(await slugsByVisibility('Озеро Кругленькое')).toEqual({
        visible: [null], hidden: ['ozero-kruglenkoe-marshrut'],
      });
      expect(await slugsByVisibility('Вулкан Бакенинг')).toEqual({
        visible: [null, null], hidden: ['vulkan-bakening-marshrut'],
      });
    });

    it('суффикс видимого тёзки не отнят; адрес по имени у видимого маршрута — суффикс не переходит', async () => {
      expect(await slugsOf('Озеро Медвежье')).toEqual(['ozero-medvezhe-marshrut', null]);
      expect(await slugsByVisibility('Вулкан Жупановский')).toEqual({
        visible: [null], hidden: ['vulkan-zhupanovskij-marshrut'],
      });
      expect(await slugsByVisibility('Сопка Мишенная')).toEqual({
        visible: [null], hidden: ['sopka-mishennaya-marshrut'],
      });
    });

    it('скрытый и слитый не тронуты, адрес писателя не переписан', async () => {
      expect(await slugsOf('Тайная тропа')).toEqual([null]);
      expect(await slugsOf('Слитый дубль')).toEqual([null]);
      expect(await slugsOf('Мутновский')).toEqual(['mutnovskij-svoj']);
    });

    it('повторный прогон миграций не меняет ничего', async () => {
      const before = await pool.query(`SELECT id, slug, updated_at FROM kamchatka_routes ORDER BY id`);
      await runMigrations();
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
        ['Бухта Тихая', 'visible_place'],
        ['Вулкан Бакенинг', 'visible_place'],
        ['Вулкан Бакенинг', 'visible_place'],
        ['Вулкан Жупановский', 'visible_route'],
        ['Медведи', 'section'],
        ['Мыс Лопатка', 'visible_place'],
        ['Озеро Голубое', 'namesake'],
        ['Озеро Голубое', 'namesake'],
        ['Озеро Дальнее', 'visible_place'],
        ['Озеро Дальнее', 'visible_place'],
        ['Озеро Кругленькое', 'visible_place'],
        ['Озеро Медвежье', 'visible_place'],
        ['Сопка Мишенная', 'visible_place'],
        ['Толбачик', 'merged_into_this'],
      ]);
      // У «Мыса Лопатки» суффиксный адрес занят — перепись это и показывает,
      // и называет держателя: решать по слову «занят» нечем.
      const lopatka = rows.find((r) => r.title === 'Мыс Лопатка');
      expect(lopatka?.marshrut_free).toBe(false);
      expect(lopatka).toMatchObject({
        marshrut_route_title: 'Мыс Лопатка (старый путь)', marshrut_route_visible: true,
        marshrut_route_merged_into: null, marshrut_place_id: null,
      });
      // Свободный суффикс — держателя нет.
      expect(rows.find((r) => r.title === '!!!')?.marshrut_route_id).toBeNull();
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

    it('новый маршрут к месту — <имя>-marshrut; второй такой же — без адреса', async () => {
      await insertRoute('Бухта Русская');
      expect(await slugsOf('Бухта Русская')).toEqual(['buhta-russkaya-marshrut']);
      await insertRoute('Бухта Русская');
      expect(await slugsOf('Бухта Русская')).toEqual(['buhta-russkaya-marshrut', null]);
    });

    it('маршрут к месту и маршрут «… маршрут» в двух транзакциях не делят адрес с суффиксом', async () => {
      await insertConcurrently('Бухта Шлюпочная', 'Бухта Шлюпочная маршрут');
      expect(await slugsOf('Бухта Шлюпочная')).toEqual(['buhta-shlyupochnaya-marshrut']);
      expect(await slugsOf('Бухта Шлюпочная маршрут')).toEqual([null]);
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
      await insertConcurrently('Халактырский пляж', 'Халактырский пляж');
      expect(await slugsOf('Халактырский пляж')).toEqual(['halaktyrskij-plyazh', null]);
    });
  });
});

/**
 * Адрес по имени МЕСТУ при записи (1491, #3566 п.2): в индексе Google места по
 * UUID — заведённые после разовой раздачи 1111 адреса не получали. Правило то
 * же, что у маршрутов: свободный адрес — месту, тёзки и адрес, занятый
 * маршрутом, — без адреса; добор и триггер; место и маршрут одного имени в
 * двух транзакциях не делят адрес. Исполняется файл миграции, не копия.
 */
withPg('адрес по имени месту при записи (1491) на настоящем PostgreSQL', () => {
  const PLACE_SCHEMA = 'place_slug_on_write_test';
  let pool: Pool;
  const slugOf = async (id: string) =>
    (await pool.query<{ slug: string | null }>(`SELECT slug FROM places WHERE id = $1`, [id])).rows[0]?.slug ?? null;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${PLACE_SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${PLACE_SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${PLACE_SCHEMA}` });
    await pool.query(TABLES);
    await pool.query(latestFunctionDdl('translit_ru_slug'));
    // До миграции: адреса раздавала 1111, у новых мест их нет.
    await pool.query(`INSERT INTO places (id, name, slug, is_visible, merged_into_id) VALUES
      ('chik', 'Вулкан Чикурачки', NULL, true, NULL),
      ('ks1', 'Вулкан Ксудач', NULL, true, NULL),
      ('twin1', 'Озеро Тёзка', NULL, true, NULL),
      ('twin2', 'Озеро Тёзка', NULL, true, NULL),
      ('hidden', 'Скрытое место', NULL, false, NULL),
      ('merged', 'Слитое место', NULL, true, 'chik'),
      ('point', 'Точка маршрута (начало)', NULL, true, NULL),
      ('own', 'Своё место', 'svoj-adres', true, NULL)`);
    await pool.query(`INSERT INTO kamchatka_routes (title, slug) VALUES ('Вулкан Ксудач', 'vulkan-ksudach')`);
    // Правило маршрутов тоже на месте: гонку места и маршрута судит их общий ключ блокировки.
    for (const f of RULE_MIGRATIONS) await pool.query(readFileSync(join(MIGRATIONS, f), 'utf-8'));
    await pool.query(readFileSync(join(MIGRATIONS, '1491_place_slug_on_write.sql'), 'utf-8'));
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${PLACE_SCHEMA} CASCADE`);
    await pool.end();
  });

  it('добор: свободный адрес выдан; тёзки, адрес маршрута, скрытое, слитое и служебное — без адреса; свой адрес не тронут', async () => {
    expect(await slugOf('chik')).toBe('vulkan-chikurachki');
    expect(await slugOf('ks1')).toBeNull();
    expect([await slugOf('twin1'), await slugOf('twin2')]).toEqual([null, null]);
    expect(await slugOf('hidden')).toBeNull();
    expect(await slugOf('merged')).toBeNull();
    expect(await slugOf('point')).toBeNull();
    expect(await slugOf('own')).toBe('svoj-adres');
  });

  it('повторный прогон миграции ничего не меняет', async () => {
    const before = (await pool.query(`SELECT id, slug FROM places ORDER BY id`)).rows;
    await pool.query(readFileSync(join(MIGRATIONS, '1491_place_slug_on_write.sql'), 'utf-8'));
    expect((await pool.query(`SELECT id, slug FROM places ORDER BY id`)).rows).toEqual(before);
  });

  it('триггер: новое место и ставшее видимым — с адресом; адрес писателя и смена имени не трогаются', async () => {
    await pool.query(`INSERT INTO places (id, name) VALUES ('new1', 'Новое озеро')`);
    expect(await slugOf('new1')).toBe('novoe-ozero');
    await pool.query(`UPDATE places SET is_visible = true WHERE id = 'hidden'`);
    expect(await slugOf('hidden')).toBe('skrytoe-mesto');
    await pool.query(`INSERT INTO places (id, name, slug) VALUES ('new2', 'Ещё место', 'dannyj-adres')`);
    expect(await slugOf('new2')).toBe('dannyj-adres');
    await pool.query(`UPDATE places SET name = 'Переименованное озеро' WHERE id = 'new1'`);
    expect(await slugOf('new1')).toBe('novoe-ozero');
  });

  it('место и маршрут одного имени в двух транзакциях: маршрут ждёт место, имя у места, маршруту — суффикс', async () => {
    const t1 = await pool.connect();
    const t2 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t2.query('BEGIN');
      await t1.query(`INSERT INTO places (id, name) VALUES ('race', 'Бухта Спорная')`);
      let routeDone = false;
      const pending = t2.query(`INSERT INTO kamchatka_routes (title) VALUES ('Бухта Спорная')`).then(() => { routeDone = true; });
      await new Promise((r) => setTimeout(r, 300));
      // Маршрут ждёт решения места на общем ключе адреса, а не проверяет его вслепую.
      expect(routeDone).toBe(false);
      await t1.query('COMMIT');
      await pending;
      await t2.query('COMMIT');
    } finally {
      t1.release();
      t2.release();
    }
    const place = await slugOf('race');
    const route = (await pool.query<{ slug: string | null }>(`SELECT slug FROM kamchatka_routes WHERE title = 'Бухта Спорная'`)).rows[0]?.slug ?? null;
    // Имя принадлежит месту, маршрут к нему — `<имя>-marshrut` (правило 1239).
    expect([place, route]).toEqual(['buhta-spornaya', 'buhta-spornaya-marshrut']);
  });
});

withPg('слияние маршрутов Долины гейзеров (1492) и адрес слитого маршрута на настоящем PostgreSQL', () => {
  const MERGE_SCHEMA = 'route_merge_1492_test';
  let pool: Pool;
  const OLD_TEXT = 'Долина гейзеров — одно из самых впечатляющих мест Камчатки, расположенное в Кроноцком биосферном заповеднике. Более 40 гейзеров.';
  const merged = async (ref: string) =>
    (await pool.query<{ canonical: string }>(MERGED_ROUTE_SQL, [ref])).rows[0]?.canonical ?? null;
  const row = async (slug: string) =>
    (await pool.query<{ id: string; is_visible: boolean; merged_into_id: string | null; description: string | null; distance_km: string | null; distance_note: string | null }>(
      `SELECT id::text AS id, is_visible, merged_into_id, description, distance_km::text AS distance_km, distance_note
         FROM kamchatka_routes WHERE slug = $1`, [slug])).rows[0];

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${MERGE_SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${MERGE_SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${MERGE_SCHEMA}` });
    await pool.query(`
      CREATE TABLE kamchatka_routes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ark_id uuid,
        title text NOT NULL,
        slug text UNIQUE,
        description text,
        distance_km numeric,
        distance_note text,
        difficulty varchar,
        difficulty_source varchar(24),
        elevation_gain_m integer,
        is_visible boolean NOT NULL DEFAULT true,
        merged_into_id text,
        merged_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE route_waypoints (
        route_id uuid NOT NULL, place_id text NOT NULL, position int NOT NULL,
        link_kind text, link_kind_at timestamptz, UNIQUE (route_id, place_id)
      );
      CREATE TABLE operator_tours (id serial PRIMARY KEY, route_id uuid);
    `);
    await pool.query(readFileSync(join(MIGRATIONS, '911_description_provenance.sql'), 'utf-8'));
    await pool.query(`INSERT INTO kamchatka_routes (id, title, slug, description, distance_km) VALUES
      ('385d1c98-0000-4000-8000-000000000001', 'Долина гейзеров', 'dolina-geyzerov-385d1c98', $1, 1.4),
      ('9e000000-0000-4000-8000-000000000002', 'Гейзеры Камчатки', 'geyzery-kamchatki', 'Более 20 крупных гейзеров.', NULL)`, [OLD_TEXT]);
    await pool.query(`INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES
      ('385d1c98-0000-4000-8000-000000000001', 'valley', 0, 'waypoint'),
      ('9e000000-0000-4000-8000-000000000002', 'valley', 0, 'waypoint'),
      ('9e000000-0000-4000-8000-000000000002', 'velikan', 1, 'waypoint')`);
    await pool.query(`INSERT INTO operator_tours (route_id) VALUES ('9e000000-0000-4000-8000-000000000002')`);
    await pool.query(`INSERT INTO kamchatka_routes (title, slug, difficulty, distance_km, elevation_gain_m) VALUES
      ('Вулкан Ключевская сопка', 'vulkan-klyuchevskaya-sopka-413a7499', 'easy', 3.5, 19),
      ('Другой лёгкий', 'drugoj-legkij', 'easy', 3.5, 19)`);
    const kl = readFileSync(join(MIGRATIONS, '1493_klyuchevskaya_route_not_easy.sql'), 'utf-8');
    await pool.query(kl);
    await pool.query(kl);
    const sql = readFileSync(join(MIGRATIONS, '1492_geyser_valley_route_merge_kronoki.sql'), 'utf-8');
    await pool.query(sql);
    // Повтор миграции ничего не меняет: guard'ы по слиянию, тексту и дистанции.
    await pool.query(sql);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${MERGE_SCHEMA} CASCADE`);
    await pool.end();
  });

  it('дубль скрыт и слит, точки и туры у выжившей, без повторов', async () => {
    const loser = await row('geyzery-kamchatki');
    expect(loser.is_visible).toBe(false);
    expect(loser.merged_into_id).toBe('385d1c98-0000-4000-8000-000000000001');
    const wp = await pool.query<{ place_id: string }>(
      `SELECT place_id FROM route_waypoints WHERE route_id = '385d1c98-0000-4000-8000-000000000001' ORDER BY position`);
    expect(wp.rows.map((r) => r.place_id)).toEqual(['valley', 'velikan']);
    const tours = await pool.query<{ route_id: string }>(`SELECT route_id::text AS route_id FROM operator_tours`);
    expect(tours.rows.map((r) => r.route_id)).toEqual(['385d1c98-0000-4000-8000-000000000001']);
  });

  it('описание — факты заповедника со ссылкой, журнал записан один раз; дистанция — 1 км по настилам', async () => {
    const keep = await row('dolina-geyzerov-385d1c98');
    expect(keep.description).toMatch(/около 60 гейзеров/);
    expect(keep.description).toMatch(/более 30/);
    expect(keep.description).toMatch(/государственный инспектор/);
    expect(keep.description).toMatch(/Источник: Кроноцкий заповедник, kronoki\.ru/);
    expect(keep.description).not.toMatch(/Великан|более 40|квадратных/);
    expect([keep.distance_km, keep.distance_note]).toEqual(['1', 'по настилам']);
    const prov = await pool.query<{ written_by: string; facts_count: number; previous_chars: number }>(
      `SELECT written_by, facts_count, previous_chars FROM description_provenance`);
    expect(prov.rows).toEqual([{ written_by: 'fact-correction', facts_count: 10, previous_chars: OLD_TEXT.length }]);
  });

  it('Ключевская (1493): не «лёгкий», ложные километры и набор сняты; соседний маршрут не тронут', async () => {
    const q = `SELECT difficulty, difficulty_source, distance_km::text AS km, elevation_gain_m AS gain FROM kamchatka_routes WHERE slug = $1`;
    expect((await pool.query(q, ['vulkan-klyuchevskaya-sopka-413a7499'])).rows[0])
      .toEqual({ difficulty: 'extreme', difficulty_source: 'owner-decision', km: null, gain: null });
    expect((await pool.query(q, ['drugoj-legkij'])).rows[0])
      .toEqual({ difficulty: 'easy', difficulty_source: null, km: '3.5', gain: 19 });
  });

  it('пустой «Под Козельский вулкан» (1494): с туром остаётся, без тура скрыт, не слит', async () => {
    const vis = async () => (await pool.query<{ is_visible: boolean; merged_into_id: string | null }>(
      `SELECT is_visible, merged_into_id FROM kamchatka_routes WHERE slug = 'pod-kozelskij-vulkan-marshrut'`)).rows[0];
    const hide = readFileSync(join(MIGRATIONS, '1494_pod_kozelskij_route_hidden.sql'), 'utf-8');
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO kamchatka_routes (title, slug, description) VALUES ('Под Козельский вулкан', 'pod-kozelskij-vulkan-marshrut', NULL) RETURNING id::text AS id`)).rows[0].id;
    await pool.query(`INSERT INTO operator_tours (route_id) VALUES ($1)`, [id]);
    await pool.query(hide);
    expect(await vis()).toEqual({ is_visible: true, merged_into_id: null });
    await pool.query(`DELETE FROM operator_tours WHERE route_id = $1`, [id]);
    await pool.query(hide);
    await pool.query(hide);
    expect(await vis()).toEqual({ is_visible: false, merged_into_id: null });
  });

  it('адрес слитого маршрута ведёт к выжившей; живой и цепочка в скрытую — без адреса', async () => {
    expect(await merged('geyzery-kamchatki')).toBe('dolina-geyzerov-385d1c98');
    expect(await merged('9e000000-0000-4000-8000-000000000002')).toBe('dolina-geyzerov-385d1c98');
    expect(await merged('dolina-geyzerov-385d1c98')).toBeNull();
    // Цепочка: A → B (слит в C) → C видим без slug — ответ id C; в скрытую цель — null.
    await pool.query(`INSERT INTO kamchatka_routes (id, title, slug, is_visible, merged_into_id) VALUES
      ('c0000000-0000-4000-8000-00000000000c', 'Цель без адреса', NULL, true, NULL),
      ('b0000000-0000-4000-8000-00000000000b', 'Промежуток', 'promezhutok', false, 'c0000000-0000-4000-8000-00000000000c'),
      ('a0000000-0000-4000-8000-00000000000a', 'Начало', 'nachalo', false, 'b0000000-0000-4000-8000-00000000000b'),
      ('d0000000-0000-4000-8000-00000000000d', 'Скрытая цель', 'skrytaya', false, NULL),
      ('e0000000-0000-4000-8000-00000000000e', 'В скрытую', 'v-skrytuyu', false, 'd0000000-0000-4000-8000-00000000000d')`);
    expect(await merged('nachalo')).toBe('c0000000-0000-4000-8000-00000000000c');
    expect(await merged('v-skrytuyu')).toBeNull();
  });
});
