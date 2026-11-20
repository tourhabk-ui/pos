/**
 * Снимки туров на карточках маршрутов и фотолента автора — на настоящем
 * PostgreSQL (21.11, lib/routes/tour-photos, lib/media/author-feed).
 *
 * Мок ответил бы на любой SQL, поэтому отбор судится здесь, на схеме прода
 * (baseline + миграции):
 *   - решение владельца 20.11 («делай без их согласия»): согласие партнёра
 *     и лицензия не нужны; снимок тура ставится на маршрут при записанной
 *     связи (тур на маршрут или главное место тура — ТОЧКА ПУТИ); автор — из
 *     gallery_credits, иначе имя партнёра со ссылкой на его страницу;
 *   - связь «рядом» — снимка нет;
 *   - в ленту автора-человека снимок места без лицензии тоже попадает и
 *     ведёт на страницу места; партнёр ленты не получает;
 *
 * Своя база `route_tour_photos_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[route-tour-photos.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'route_tour_photos_test';

const ROUTE = 'c2110000-0000-4000-8000-000000000001';
const ROUTE_NEARBY_ONLY = 'c2110000-0000-4000-8000-000000000002';
const PEAK = { id: 'b2110000-0000-4000-8000-000000000001', ark: 'a2110000-0000-4000-8000-000000000001', slug: 'test-rtp-peak', name: 'Тестовые Востряки' };
const NEAR = { id: 'b2110000-0000-4000-8000-000000000002', ark: 'a2110000-0000-4000-8000-000000000002', slug: 'test-rtp-near', name: 'Тестовый вид рядом' };
const LAKE = { id: 'b2110000-0000-4000-8000-000000000003', ark: 'a2110000-0000-4000-8000-000000000003', slug: 'test-rtp-lake', name: 'Тестовое озеро' };

const GUIDE = { id: 'd2110000-0000-4000-8000-000000000001', name: 'Тест Гид Альфа', slug: 'test-rtp-guide' };
const OLD = { id: 'd2110000-0000-4000-8000-000000000002', name: 'Тест Оператор Старый', slug: 'test-rtp-old' };
const NOCREDIT = { id: 'd2110000-0000-4000-8000-000000000003', name: 'Тест Оператор Безподписи', slug: 'test-rtp-nocredit' };
const NEARBY_OP = { id: 'd2110000-0000-4000-8000-000000000004', name: 'Тест Оператор Рядом', slug: 'test-rtp-nearby' };

const TOURIST = 'Тестовая Туристка Бета';
const UNLICENSED = 'Тестовый Турист Гамма';

const url = (n: string) => `https://s3.example.test/bucket/images/tours/rtp-${n}.jpg`;

withPg('снимки туров на маршрутах и фотолента автора (21.11)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    for (const p of [PEAK, NEAR, LAKE]) {
      await pool.query(
        `INSERT INTO places (id, name, slug, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, $2, $3, 53.4, 157.7, $4, 'mountain', 'avachinsky', TRUE)`,
        [p.id, p.name, p.slug, p.ark],
      );
    }
    for (const [id, title] of [[ROUTE, 'Тестовые Востряки (маршрут)'], [ROUTE_NEARBY_ONLY, 'Тестовый маршрут только рядом']]) {
      await pool.query(
        `INSERT INTO kamchatka_routes (id, category, title, zone, is_visible) VALUES ($1, 'trekking', $2, 'avachinsky', TRUE)`,
        [id, title],
      );
    }
    await pool.query(
      `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES
         ($1, $2, 0, 'waypoint'), ($1, $3, 1, 'nearby'), ($4, $3, 0, 'nearby')`,
      [ROUTE, PEAK.id, NEAR.id, ROUTE_NEARBY_ONLY],
    );

    const credits: Record<string, Record<string, string>> = {
      [GUIDE.id]: { [url('guide-1')]: GUIDE.name, [url('guide-2')]: TOURIST },
      [OLD.id]: { [url('old-1')]: OLD.name },
      [NOCREDIT.id]: {},
      [NEARBY_OP.id]: { [url('near-1')]: NEARBY_OP.name },
    };
    for (const p of [GUIDE, OLD, NOCREDIT, NEARBY_OP]) {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status, gallery_credits)
         VALUES ($1, $2, 'operator', '{}'::jsonb, $3, TRUE, TRUE, 'active', $4::jsonb)`,
        [p.id, p.name, p.slug, JSON.stringify(credits[p.id])],
      );
    }
    const { PLACE_CARDS_CONSENT_FROM } = await import('@/lib/legal/partner-materials-consent');
    for (const [p, version] of [[GUIDE, PLACE_CARDS_CONSENT_FROM], [OLD, '2026-10-23'], [NEARBY_OP, PLACE_CARDS_CONSENT_FROM]] as const) {
      await pool.query(
        `INSERT INTO partner_material_consents
           (partner_id, text_version, signed_text, signer_name, signer_role, source, pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
         VALUES ($1, $2, $3, 'Тест Подписант', 'владелец', 'link', NOW(), '127.0.0.1', 'test', 'v1')`,
        [p.id, version, 'Текст согласия для теста. '.repeat(20)],
      );
    }
    const tour = async (op: { id: string }, slug: string, photos: string[], link: { main?: string; route?: string }) => {
      await pool.query(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, difficulty,
                                     is_active, is_published, photos, main_place_id, route_id)
         VALUES ($1, $2, $2, 'trekking', 15000, 'per_person', 1, 10, 8, 'medium', TRUE, TRUE, $3::text[], $4, $5)`,
        [op.id, slug, photos, link.main ?? null, link.route ?? null],
      );
    };
    await tour(GUIDE, 'test-rtp-guide-peak', [url('guide-uncredited'), url('guide-1'), url('guide-2')], { main: PEAK.id });
    await tour(OLD, 'test-rtp-old-peak', [url('old-1')], { main: PEAK.id });
    await tour(NOCREDIT, 'test-rtp-nocredit-route', [url('nocredit-1')], { route: ROUTE });
    await tour(NEARBY_OP, 'test-rtp-nearby', [url('near-1')], { main: NEAR.id });

    // Снимки мест для ленты: с лицензией и без.
    await pool.query(
      `INSERT INTO ai_route_images (route_id, s3_url, s3_key, model, author, license)
       VALUES ($1, 'https://s3.example.test/l.jpg', 'photos/test/rtp-lake.jpg', 'manual-upload', $2, 'CC BY 4.0'),
              ($3, 'https://s3.example.test/n.jpg', 'photos/test/rtp-near.jpg', 'manual-upload', $4, NULL)`,
      [LAKE.ark, TOURIST, NEAR.ark, UNLICENSED],
    );
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('маршрут: по снимку от партнёра, по алфавиту; согласие не нужно; без автора — партнёр', async () => {
    const { ROUTE_TOUR_PHOTOS_SQL, toRouteTourPhotos } = await import('@/lib/routes/tour-photos');
    const { rows } = await pool.query(ROUTE_TOUR_PHOTOS_SQL, [ROUTE]);
    const photos = toRouteTourPhotos(rows as never, { feedSlugs: new Set(), feedEnabled: true });
    // GUIDE — согласие новой версии, OLD — прежней, NOCREDIT — без согласия и без gallery_credits.
    expect(photos.map((p) => p.url)).toEqual([url('guide-1'), url('nocredit-1'), url('old-1')]);
    expect(photos[0].credit).toEqual({ name: GUIDE.name, href: `/operators/${GUIDE.slug}`, kind: 'partner' });
    expect(photos[0].placeName).toBe(PEAK.name);
    expect(photos[1].credit).toEqual({ name: NOCREDIT.name, href: `/operators/${NOCREDIT.slug}`, kind: 'partner' });
    expect(photos[2].credit).toEqual({ name: OLD.name, href: `/operators/${OLD.slug}`, kind: 'partner' });
    // Связь «рядом» — не на маршруте.
    expect(rows.map((r) => (r as { url: string }).url)).not.toContain(url('near-1'));
  });

  it('маршрут только со связью «рядом» снимка тура не получает', async () => {
    const { ROUTE_TOUR_PHOTOS_SQL } = await import('@/lib/routes/tour-photos');
    const { rows } = await pool.query(ROUTE_TOUR_PHOTOS_SQL, [ROUTE_NEARBY_ONLY]);
    expect(rows).toEqual([]);
  });

  it('карточки списка: тот же снимок одним запросом', async () => {
    const { loadRouteCardTourPhotos } = await import('@/lib/routes/tour-photos');
    const res = await loadRouteCardTourPhotos([ROUTE, ROUTE_NEARBY_ONLY], { feedEnabled: true });
    expect(res.state).toBe('ok');
    if (res.state !== 'ok') return;
    expect(res.photos.get(ROUTE)?.url).toBe(url('guide-1'));
    expect(res.photos.has(ROUTE_NEARBY_ONLY)).toBe(false);
  });

  it('лента: снимки и с лицензией, и без — со ссылкой на место; партнёр ленты не получает', async () => {
    const { loadAuthorFeed } = await import('@/lib/media/author-feed');
    const { authorFeedSlug } = await import('@/lib/media/author-credit');
    const beta = await loadAuthorFeed(authorFeedSlug(TOURIST)!);
    expect(beta.state).toBe('ok');
    if (beta.state !== 'ok') return;
    expect(beta.feed.name).toBe(TOURIST);
    const hrefs = beta.feed.photos.map((p) => p.href).sort();
    // Снимок места с лицензией и снимок тура, записанный за ней, — оба ведут на места.
    expect(hrefs).toEqual([`/places/${LAKE.slug}`, `/places/${PEAK.slug}`].sort());

    const gamma = await loadAuthorFeed(authorFeedSlug(UNLICENSED)!);
    expect(gamma.state).toBe('ok');
    if (gamma.state !== 'ok') return;
    expect(gamma.feed.photos.map((p) => [p.href, p.license])).toEqual([[`/places/${NEAR.slug}`, null]]);
    // Партнёр ленты не получает — его подпись ведёт на его страницу.
    expect((await loadAuthorFeed(authorFeedSlug(GUIDE.name)!)).state).toBe('none');
  });
});
