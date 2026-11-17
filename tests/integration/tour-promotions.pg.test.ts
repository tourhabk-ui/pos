/**
 * Акция оператора на карточке тура — на настоящем PostgreSQL (слово владельца
 * 17.11 «покажи»: акция «Лагуны Экспедиции» «Для жителей Дальнего Востока»).
 *
 * Судится то, что решает база, а мок ответил бы на любой SQL:
 *  - миграция 1460 кладёт акцию ровно четырём турам «Лагуны» по их адресам,
 *    другим турам — нет; повтор миграции второй строки не даёт;
 *  - акция видна, пока сегодня по Камчатке (UTC+12) лежит в сроке
 *    бронирования 18.11–01.12.2026 включительно, и пропадает сама: 17.11 по
 *    Камчатке её нет, 01.12 в 23:59 она есть, 02.12 в 00:00 — нет;
 *  - ответ ИИ-агенту (get_tour_details) несёт её теми же словами, что
 *    карточка; после срока — ни слова.
 *
 * Своя база `tour_promotions_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[tour-promotions.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'tour_promotions_test';
const LAGUNA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROMO_SLUGS = [
  'lagexp-kamchatka-termalnyj-marshrut',
  'lagexp-vulkany-kamchatki-4-dnya',
  'lagexp-vulkany-kamchatki-5-dnej',
  'lagexp-kamchatka-na-maksimum-zimnij-marshrut',
];
const MIGRATION = readFileSync(join(process.cwd(), 'migrations', '1460_tour_promotions.sql'), 'utf-8');

/** Момент по Камчатке → миллисекунды UTC. */
const atKamchatka = (local: string) => Date.parse(`${local}+12:00`);

withPg('акция оператора: срок, адресаты, слова', () => {
  let pool: import('pg').Pool;
  const ids = new Map<string, number>();

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    await pool.query('TRUNCATE partners, operator_tours, tour_promotions CASCADE');

    const partner = async (id: string, name: string, slug: string) => {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, contacts, slug, is_public, is_verified, status)
         VALUES ($1, $2, 'operator', '{}'::jsonb, '{}'::jsonb, $3, TRUE, TRUE, 'active')`,
        [id, name, slug],
      );
    };
    await partner(LAGUNA, 'Лагуна Экспедиция', 'laguna-expedition');
    await partner(OTHER, 'Другая компания', 'other-company');

    const tour = async (op: string, title: string, slug: string) => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, max_participants,
                                     is_active, is_published)
         VALUES ($1, $2, $3, 'excursion', 45000, 10, TRUE, TRUE) RETURNING id`,
        [op, title, slug],
      );
      ids.set(slug, rows[0].id);
    };
    await tour(LAGUNA, 'Камчатка: термальный маршрут', PROMO_SLUGS[0]);
    await tour(LAGUNA, 'Вулканы Камчатки (4 дня)', PROMO_SLUGS[1]);
    await tour(LAGUNA, 'Вулканы Камчатки (5 дней)', PROMO_SLUGS[2]);
    await tour(LAGUNA, 'Камчатка на максимум: зимний маршрут', PROMO_SLUGS[3]);
    // Новогодний тур той же компании в акцию не входит.
    await tour(LAGUNA, 'Вулканы Камчатки 4 дня (новогодние праздники)', 'lagexp-vulkany-kamchatki-4-dnya-novogodnie-prazdniki');
    // Тур другой компании акция «Лагуны» не касается.
    await tour(OTHER, 'Вулканы Камчатки у другой компании', 'other-vulkany-kamchatki');

    // Шаблон базы уже прогнал миграцию, когда туров не было; прогон с турами — как на проде.
    await pool.query(MIGRATION);
  }, 120_000);

  afterEach(() => { vi.useRealTimers(); });

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  }, 60_000);

  it('миграция кладёт акцию ровно четырём турам «Лагуны», повтор второй строки не даёт', async () => {
    await pool.query(MIGRATION);
    const { rows } = await pool.query<{ slug: string; offer: string; booking_from: string; booking_until: string }>(
      `SELECT t.slug, p.offer, to_char(p.booking_from, 'YYYY-MM-DD') AS booking_from,
              to_char(p.booking_until, 'YYYY-MM-DD') AS booking_until
         FROM tour_promotions p JOIN operator_tours t ON t.id = p.tour_id ORDER BY t.slug`,
    );
    expect(rows.map((r) => r.slug)).toEqual([...PROMO_SLUGS].sort());
    expect(new Set(rows.map((r) => `${r.booking_from}..${r.booking_until}`))).toEqual(new Set(['2026-11-18..2026-12-01']));
    expect(rows.find((r) => r.slug === PROMO_SLUGS[0])?.offer).toMatch(/^Скидка 15 000 ₽ с человека/);
    expect(rows.find((r) => r.slug === PROMO_SLUGS[1])?.offer).toBe('Ужин по тарифу «Всё включено» в подарок.');
  });

  it('база отвергает срок задом наперёд и адрес не https', async () => {
    const id = ids.get(PROMO_SLUGS[0]);
    await expect(pool.query(
      `INSERT INTO tour_promotions (tour_id, title, offer, conditions, booking_from, booking_until, source_url, checked_on)
       VALUES ($1, 'x', 'x', 'x', '2026-12-02', '2026-12-01', 'https://a.ru/x', '2026-11-17')`, [id],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO tour_promotions (tour_id, title, offer, conditions, booking_from, booking_until, source_url, checked_on)
       VALUES ($1, 'x', 'x', 'x', '2026-11-18', '2026-12-01', 'http://a.ru/x', '2026-11-17')`, [id],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('видна в сроке по Камчатке и пропадает сама после 1 декабря', async () => {
    const { loadActiveTourPromotions } = await import('@/lib/tours/tour-promotion');
    const id = ids.get(PROMO_SLUGS[1])!;
    const at = async (local: string) => {
      const r = await loadActiveTourPromotions(id, { now: atKamchatka(local) });
      expect(r.state).toBe('ok');
      return r.state === 'ok' ? r.items.length : -1;
    };
    expect(await at('2026-11-17T23:59:00')).toBe(0);
    expect(await at('2026-11-18T00:00:00')).toBe(1);
    expect(await at('2026-12-01T23:59:00')).toBe(1);
    expect(await at('2026-12-02T00:00:00')).toBe(0);
    // Не входящий в акцию тур той же компании — без акции и в срок.
    const ny = await loadActiveTourPromotions(ids.get('lagexp-vulkany-kamchatki-4-dnya-novogodnie-prazdniki')!, { now: atKamchatka('2026-11-20T12:00:00') });
    expect(ny).toEqual({ state: 'ok', items: [] });
  });

  it('ответ ИИ-агенту несёт акцию словами карточки, после срока — ни слова', async () => {
    const { getTourDetails } = await import('@/lib/kuzmich/core');
    const { PROMOTION_PRICE_NOTE } = await import('@/lib/tours/tour-promotion');
    const id = ids.get(PROMO_SLUGS[0])!;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(atKamchatka('2026-11-20T12:00:00'));
    const during = await getTourDetails(String(id));
    expect(during).toContain('Акция оператора «Для жителей Дальнего Востока»');
    expect(during).toContain('Бронирование с 18 ноября по 1 декабря 2026');
    expect(during).toContain('По этому туру: Скидка 15 000 ₽ с человека');
    expect(during).toContain('с действующей пропиской');
    expect(during).toContain(PROMOTION_PRICE_NOTE);
    expect(during).toContain('https://laguna-expedition.ru/aktsii/dlya-zhitelej-dalnego-vostoka');

    vi.setSystemTime(atKamchatka('2026-12-02T09:00:00'));
    const after = await getTourDetails(String(id));
    expect(after).toContain('Камчатка: термальный маршрут');
    expect(after).not.toContain('Акция оператора');
    expect(after).not.toContain('пропиской');
  });
});
