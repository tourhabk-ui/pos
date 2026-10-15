/**
 * Снимки партнёров без согласия на карточки мест — на настоящем PostgreSQL
 * (1263 «Местечко Камчатка», 1265 «Край Вулканов»).
 *
 * «Местечко Камчатка» дало «ДА» на снимки своих туров (1217), а 14.10 их кадры
 * легли и на карточки мест. Владелец 15.10 на вопрос, покрывает ли то «ДА»
 * карточки мест: «пока нет получим согласе востановим». У «Края Вулканов» было
 * только слово владельца «публикуй фото и туры» (1177) — о турах, — и его кадры
 * спрятаны тем же порядком. Отсюда три обещания, и каждое проверяется здесь
 * поведением, а не текстом:
 *
 *   спрятано — карточка, фото путевых точек маршрута и обе раздачи кадра не
 *     отдают ни героя, ни кадра галереи партнёра; подписи с его именем нет;
 *     и прячет каждая миграция только своего партнёра;
 *   не удалено — строки на месте, с автором и ключом хранилища;
 *   восстановимо — обратная правка из хвоста миграции, выполненная как есть,
 *     возвращает кадры на карточку — и только своего партнёра. Комментарий,
 *     обещающий возврат, без этой проверки был бы объявлением без исполнения
 *     (§10.09).
 *
 * Мок ответил бы на любой SQL, поэтому сцена разыгрывается на схеме baseline
 * прода плюс всех миграций; 1263 и 1265 затем прогоняются ещё дважды по
 * засеянным строкам — так же, как они лягут на прод, и повторно, как велит
 * идемпотентность.
 *
 * Своя база `partner_photos_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[partner-photos-no-consent.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'partner_photos_test';
/** Первая миграция после baseline (снимок прода 2026-08-15, последняя в нём — 862). */
const FIRST_AFTER_BASELINE = 863;
const OWNER = 'владелец платформы';

/** Место с героем партнёра и двумя кадрами галереи: партнёра и владельца. */
const SPRINGS = { id: 'b1260000-0000-4000-8000-000000000001', ark: 'a1260000-0000-4000-8000-000000000001' };
/** То же устройство — у второго партнёра. */
const LAKE = { id: 'b1260000-0000-4000-8000-000000000003', ark: 'a1260000-0000-4000-8000-000000000003' };
/** Место с героем владельца — контроль: его ни одна из миграций не трогает. */
const VOLCANO = { id: 'b1260000-0000-4000-8000-000000000002', ark: 'a1260000-0000-4000-8000-000000000002' };
const ROUTE = 'c1260000-0000-4000-8000-000000000001';

const CASES = [
  {
    no: 1263, partner: 'Местечко Камчатка', place: SPRINGS,
    sql: readFileSync(join(process.cwd(), 'migrations/1263_partner_photos_no_consent_hidden.sql'), 'utf-8'),
  },
  {
    no: 1265, partner: 'Край Вулканов', place: LAKE,
    sql: readFileSync(join(process.cwd(), 'migrations/1265_volcanoesland_photos_off_place_cards.sql'), 'utf-8'),
  },
] as const;
const [MESTECHKO, VOLCANOESLAND] = CASES;

const S3 = 'https://s3.example.test/bucket';
const heroUrl = (ark: string) => `${S3}/places/${ark}/hero.jpg`;
const galleryUrl = (ark: string, pos: number) => `${S3}/places/${ark}/g${pos}.jpg`;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Обратная правка — строки хвоста после «Вернуть», без «-- », как есть. */
function restoreSql(migration: string): string {
  const at = migration.indexOf('-- Вернуть');
  expect(at, 'в миграции нет обратной правки').toBeGreaterThan(-1);
  return migration.slice(at)
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('-- '))
    .map((l) => l.slice(3))
    .join('\n');
}

withPg('снимки партнёров без согласия: спрятаны, не удалены, восстановимы (1263, 1265)', () => {
  let pool: import('pg').Pool;

  async function card(id: string) {
    const { loadPlaceDetail } = await import('@/lib/places/place-detail');
    const res = await loadPlaceDetail(id, { countView: false });
    expect(res.status).toBe(200);
    return res.body.data as {
      images: string[]; photoUrl: string | null; photoCount: number;
      photoAttribution: { author: string | null } | null; photoCredits: Record<string, string | null>;
    };
  }

  async function heroStatus(ark: string): Promise<number> {
    const { GET } = await import('@/app/api/images/route/[routeId]/route');
    const res = await GET(new NextRequest(`http://localhost/api/images/route/${ark}`), {
      params: Promise.resolve({ routeId: ark }),
    });
    return res.status;
  }

  async function galleryStatus(ark: string, position: number): Promise<number> {
    const { GET } = await import('@/app/api/images/place-gallery/[arkId]/[position]/route');
    const res = await GET(new NextRequest(`http://localhost/api/images/place-gallery/${ark}/${position}`), {
      params: Promise.resolve({ arkId: ark, position: String(position) }),
    });
    return res.status;
  }

  async function routePhotos(): Promise<string[]> {
    const { WAYPOINT_PHOTOS_SQL } = await import('@/lib/routes/waypoint-photos');
    const { rows } = await pool.query<{ url: string }>(WAYPOINT_PHOTOS_SQL, [ROUTE]);
    return rows.map((r) => r.url);
  }

  /** Только строки сцены: миграции кладут и свои снимки к своим местам. */
  async function snapshot() {
    return (await pool.query(
      `SELECT 'hero' AS t, route_id::text AS ark, NULL::int AS pos, model, author, s3_key, s3_url, NULL AS hidden_reason
         FROM ai_route_images WHERE route_id = ANY($1::uuid[])
       UNION ALL
       SELECT 'gallery', ark_id::text, position, NULL, author, s3_key, s3_url, hidden_reason
         FROM place_gallery_photos WHERE ark_id = ANY($1::uuid[])
       ORDER BY 1, 2, 3`,
      [[SPRINGS.ark, LAKE.ark, VOLCANO.ark]],
    )).rows as Array<{ t: string; ark: string; pos: number | null; model: string | null; author: string; s3_url: string; hidden_reason: string | null }>;
  }

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    const dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    await pool.query(
      `DELETE FROM _migrations
        WHERE (regexp_match(name, '^(\\d+)_'))[1]::int >= $1`,
      [FIRST_AFTER_BASELINE],
    );
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

    // Карточка и раздача читают пул приложения — ему нужен тот же адрес.
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    for (const [p, name, type] of [
      [SPRINGS, 'Налычевские источники (тест)', 'hot_spring'],
      [LAKE, 'Курильское озеро (тест)', 'lake'],
      [VOLCANO, 'Корякская сопка (тест)', 'volcano'],
    ] as const) {
      await pool.query(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, $2, 53.4, 158.9, $3, $4, 'avachinsky', TRUE)`,
        [p.id, name, p.ark, type],
      );
    }
    for (const c of CASES) {
      await pool.query(
        `INSERT INTO ai_route_images (route_id, s3_url, s3_key, model, author, license, source_url)
         VALUES ($1, $2, $3, 'manual-upload', $4, 'с разрешения туроператора', 'https://vedarai.ru/operators/partner')`,
        [c.place.ark, heroUrl(c.place.ark), `photos/test/${c.no}-hero.jpg`, c.partner],
      );
      await pool.query(
        `INSERT INTO place_gallery_photos (ark_id, position, s3_url, width, height, caption, author)
         VALUES ($1, 1, $2, 1200, 860, 'Кадр партнёра', $3),
                ($1, 2, $4, 1280, 720, 'Кадр владельца', $5)`,
        [c.place.ark, galleryUrl(c.place.ark, 1), c.partner, galleryUrl(c.place.ark, 2), OWNER],
      );
    }
    await pool.query(
      `INSERT INTO ai_route_images (route_id, s3_url, s3_key, model, author)
       VALUES ($1, $2, 'migrations/photos/owner.jpg', 'manual-upload', $3)`,
      [VOLCANO.ark, heroUrl(VOLCANO.ark), OWNER],
    );
    await pool.query(
      `INSERT INTO kamchatka_routes (id, category, title, zone, is_visible)
       VALUES ($1, 'trekking', 'Налычевская долина (тест)', 'avachinsky', TRUE)`,
      [ROUTE],
    );
    await pool.query(
      `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES
         ($1, $2, 0, 'waypoint'), ($1, $3, 1, 'waypoint'), ($1, $4, 2, 'waypoint')`,
      [ROUTE, SPRINGS.id, VOLCANO.id, LAKE.id],
    );
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('до миграций кадры обоих партнёров на карточках — сцена поставлена верно', async () => {
    for (const { partner, place } of CASES) {
      const c = await card(place.id);
      expect(c.images.some((u) => u.startsWith(`/api/images/route/${place.ark}`)), partner).toBe(true);
      expect(c.images.some((u) => u.startsWith(`/api/images/place-gallery/${place.ark}/1`)), partner).toBe(true);
      expect(c.photoAttribution?.author).toBe(partner);
      expect(await heroStatus(place.ark)).toBe(302);
      expect(await galleryStatus(place.ark, 1)).toBe(302);
    }
  });

  it('каждая миграция прячет кадры своего партнёра по автору и ничего не удаляет; повтор ничего не меняет', async () => {
    const before = await snapshot();
    const of = (rows: typeof before, ark: string) => rows.filter((r) => r.ark === ark);

    // 1263 — только «Местечко»: кадры «Края Вулканов» на месте.
    await pool.query(MESTECHKO.sql);
    const afterFirst = await snapshot();
    expect(of(afterFirst, LAKE.ark)).toEqual(of(before, LAKE.ark));
    expect(of(afterFirst, VOLCANO.ark)).toEqual(of(before, VOLCANO.ark));

    // 1265 — только «Край Вулканов»: кадры «Местечка» его не касаются.
    await pool.query(VOLCANOESLAND.sql);
    const both = await snapshot();
    expect(of(both, SPRINGS.ark)).toEqual(of(afterFirst, SPRINGS.ark));
    expect(of(both, VOLCANO.ark)).toEqual(of(before, VOLCANO.ark));

    for (const c of CASES) await pool.query(c.sql);
    expect(await snapshot()).toEqual(both);
    expect(both).toHaveLength(before.length);

    for (const { partner, place } of CASES) {
      const rows = of(both, place.ark);
      // Автор и адрес в хранилище остались — вернуть будет что.
      expect(rows.find((r) => r.t === 'hero')).toMatchObject({
        model: 'partner-no-consent', author: partner, s3_url: heroUrl(place.ark),
      });
      const g1 = rows.find((r) => r.t === 'gallery' && r.pos === 1)!;
      expect(g1.hidden_reason, partner).toMatch(/согласия на показ на карточках мест пока нет/);
      expect(g1.hidden_reason, partner).toContain(`«${partner}»`);
      expect(g1.s3_url).toBe(galleryUrl(place.ark, 1));
      expect(rows.find((r) => r.t === 'gallery' && r.pos === 2)?.hidden_reason).toBeNull();
    }
    expect(of(both, VOLCANO.ark)[0]).toMatchObject({ model: 'manual-upload', author: OWNER });
  });

  it('карточки мест: ни героя, ни кадра партнёра, ни его имени в подписи; кадр владельца остался', async () => {
    for (const { partner, place } of CASES) {
      const c = await card(place.id);
      expect(c.images, partner).toHaveLength(1);
      expect(c.images[0]).toMatch(new RegExp(`^/api/images/place-gallery/${place.ark}/2\\?v=\\d+$`));
      // Первым кадром — оставшийся кадр галереи, а не адрес спрятанного героя:
      // при одном кадре PlaceHero берёт именно photoUrl.
      expect(c.photoUrl).toBe(c.images[0]);
      expect(c.photoCount).toBe(1);
      expect(c.photoAttribution).toBeNull();
      expect(Object.values(c.photoCredits)).toEqual([OWNER]);
      expect(JSON.stringify(c)).not.toContain(partner);
    }
  });

  it('фото маршрута из точек пути не берут спрятанное', async () => {
    const urls = await routePhotos();
    for (const { place } of CASES) {
      expect(urls.some((u) => u.includes(place.ark) && u.startsWith('/api/images/route/'))).toBe(false);
      expect(urls.some((u) => u.startsWith(`/api/images/place-gallery/${place.ark}/1`))).toBe(false);
      expect(urls.some((u) => u.startsWith(`/api/images/place-gallery/${place.ark}/2`))).toBe(true);
    }
    expect(urls.some((u) => u.startsWith(`/api/images/route/${VOLCANO.ark}`))).toBe(true);
  });

  it('раздача по прямому адресу: спрятанное — 404, остальное отдаётся', async () => {
    for (const { place } of CASES) {
      expect(await heroStatus(place.ark)).toBe(404);
      expect(await galleryStatus(place.ark, 1)).toBe(404);
      expect(await galleryStatus(place.ark, 2)).toBe(302);
    }
    expect(await heroStatus(VOLCANO.ark)).toBe(302);
  });

  it('обратная правка из хвоста миграции возвращает кадры своего партнёра — и только его', async () => {
    await pool.query(restoreSql(VOLCANOESLAND.sql));
    const lake = await card(LAKE.id);
    expect(lake.images[0]).toMatch(new RegExp(`^/api/images/route/${LAKE.ark}`));
    expect(lake.images).toHaveLength(3);
    expect(lake.photoAttribution?.author).toBe(VOLCANOESLAND.partner);
    expect(await heroStatus(LAKE.ark)).toBe(302);
    expect(await galleryStatus(LAKE.ark, 1)).toBe(302);
    // «Местечко» по-прежнему спрятано: возврат одного не возвращает другого.
    expect((await card(SPRINGS.id)).images).toHaveLength(1);
    expect(await heroStatus(SPRINGS.ark)).toBe(404);

    await pool.query(restoreSql(MESTECHKO.sql));
    const springs = await card(SPRINGS.id);
    expect(springs.images[0]).toMatch(new RegExp(`^/api/images/route/${SPRINGS.ark}`));
    expect(springs.images).toHaveLength(3);
    expect(springs.photoAttribution?.author).toBe(MESTECHKO.partner);
    expect(await heroStatus(SPRINGS.ark)).toBe(302);
    expect(await galleryStatus(SPRINGS.ark, 1)).toBe(302);
  });
});
