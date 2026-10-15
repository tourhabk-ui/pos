/**
 * «Рядом» на карточке места — по настоящему расстоянию (14.10), на настоящем
 * PostgreSQL.
 *
 * Прежний запрос сортировал места по сумме квадратов разниц в градусах. На
 * широте Камчатки градус долготы почти вдвое короче градуса широты, и место в
 * 20 км к востоку проигрывало шести местам в 22–28 км к северу — в шестёрку не
 * попадало вовсе, а показанные километры шли не по порядку. Порядок задаёт SQL,
 * мок ответил бы на него чем угодно, поэтому здесь исполняется сам запрос из
 * lib/places/nearby — на схеме прода, в своей базе из шаблона
 * (tests/helpers/pg-schema.ts).
 *
 * До 15.10 таблицы здесь писались руками, и рукописная схема разошлась с
 * прод-схемой молча: `merged_into_id` был text (в него и писали «другое-место»),
 * а у прода это uuid; `id` с `ark_id` получали значения по умолчанию, которых
 * у прода нет; места без `location_type` прод не принимает вовсе
 * (places_shape_check). Запрос проходил на выдуманной таблице — аудит 15.10,
 * P2-10.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { NEARBY_LIMIT, NEARBY_PLACES_SQL } from '../../lib/places/nearby';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[place-nearby] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

const TEST_DB = 'place_nearby_test';
const ORIGIN = { lat: 53.0, lng: 158.65, ark: '00000000-0000-4000-8000-000000000000' };

/** [имя, широта, долгота, видимо, слито в (ark_id)] — расстояния от точки ORIGIN. */
const PLACES: Array<[string, number, number, boolean, string | null]> = [
  ['Восток 20 км', 53.0, 158.95, true, null],          // 0,30° долготы ≈ 20 км; в градусах «дальше» всех северных
  ['Север 22 км', 53.2, 158.65, true, null],
  ['Север 23 км', 53.21, 158.65, true, null],
  ['Север 24 км', 53.22, 158.65, true, null],
  ['Север 26 км', 53.23, 158.65, true, null],
  ['Север 27 км', 53.24, 158.65, true, null],
  ['Север 28 км', 53.25, 158.65, true, null],          // седьмое — за пределом шестёрки
  ['Скрытое 1 км', 53.01, 158.65, false, null],
  ['Слитое 2 км', 53.02, 158.65, true, ORIGIN.ark],
  ['Вне рамки', 53.0, 159.5, true, null],              // 0,85° долготы — за рамкой ±0,8°
];

withPg('«Рядом» на карточке места — по настоящему расстоянию', () => {
  let pool: Pool;
  const arkOf = new Map<string, string>();

  beforeAll(async () => {
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    // Миграции сеют свои места и снимки, а «рядом» считается по ВСЕМ местам:
    // посторонняя строка у Петропавловска сдвинула бы шестёрку. База своя —
    // чистим обе таблицы целиком.
    await pool.query('TRUNCATE places, ai_route_images CASCADE');
    // У прода ни `id`, ни `ark_id` значения по умолчанию не имеют — даём оба;
    // `location_type` обязателен (places_shape_check) — место без рода прод
    // не примет, и фикстура без него описывала бы место, которого быть не может.
    // Имя и slug — одним параметром, но у прода это text и varchar(80): без
    // явного приведения сервер отвечает 42P08 (урок 24.08 в CLAUDE.md).
    await pool.query(
      `INSERT INTO places (id, ark_id, name, lat, lng, location_type)
       VALUES ('nearby-origin', $1, 'Само место', $2, $3, 'volcano')`,
      [ORIGIN.ark, ORIGIN.lat, ORIGIN.lng]);
    for (const [name, lat, lng, visible, merged] of PLACES) {
      const r = await pool.query<{ ark_id: string }>(
        `INSERT INTO places (id, ark_id, name, slug, lat, lng, is_visible, merged_into_id, location_type)
         VALUES (gen_random_uuid()::text, gen_random_uuid(), $1::text, $1::text, $2, $3, $4, $5, 'lake')
         RETURNING ark_id::text`,
        [name, lat, lng, visible, merged]);
      arkOf.set(name, r.rows[0].ark_id);
    }
    // Снимок показываемого рода — миниатюра есть; снимок непоказываемого рода — нет.
    await pool.query(`INSERT INTO ai_route_images (route_id, model) VALUES ($1, 'wikimedia'), ($2, 'flux-schnell')`,
      [arkOf.get('Север 22 км'), arkOf.get('Север 23 км')]);
    // Первый файл прогона строит шаблон схемы — это дольше умолчания в 10 с.
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function nearby() {
    const { rows } = await pool.query<{ name: string; slug: string | null; distance_km: number; thumb_url: string | null }>(
      NEARBY_PLACES_SQL, [ORIGIN.lat, ORIGIN.lng, ORIGIN.ark]);
    return rows;
  }

  it('ближайшее к востоку — первым, а не за пределом шестёрки', async () => {
    const rows = await nearby();
    expect(rows.map((r) => r.name)).toEqual([
      'Восток 20 км', 'Север 22 км', 'Север 23 км', 'Север 24 км', 'Север 26 км', 'Север 27 км',
    ]);
    expect(rows).toHaveLength(NEARBY_LIMIT);
  });

  it('показанные километры идут по возрастанию — порядок тот же, что видит человек', async () => {
    const km = (await nearby()).map((r) => r.distance_km);
    expect(km[0]).toBe(20);
    expect(km).toEqual([...km].sort((a, b) => a - b));
  });

  it('само место, скрытое, слитое и вне рамки — не «рядом»', async () => {
    const names = (await nearby()).map((r) => r.name);
    for (const gone of ['Само место', 'Скрытое 1 км', 'Слитое 2 км', 'Вне рамки']) {
      expect(names).not.toContain(gone);
    }
  });

  it('ссылка «рядом» — по ЧПУ: slug места в ответе', async () => {
    // Фикстура пишет slug равным имени — так видно, что пришёл именно он.
    for (const r of await nearby()) expect(r.slug).toBe(r.name);
  });

  it('миниатюра — только у снимка показываемого рода', async () => {
    const byName = new Map((await nearby()).map((r) => [r.name, r.thumb_url]));
    expect(byName.get('Север 22 км')).toMatch(new RegExp(`^/api/images/route/${arkOf.get('Север 22 км')}\\?v=\\d+$`));
    expect(byName.get('Север 23 км')).toBeNull();
  });
});
