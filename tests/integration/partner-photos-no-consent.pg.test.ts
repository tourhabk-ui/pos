/**
 * Снимки партнёра без согласия на карточки мест — на настоящем PostgreSQL (1260).
 *
 * «Местечко Камчатка» дало «ДА» на снимки своих туров (1217), а 14.10 их кадры
 * легли и на карточки мест. Владелец 15.10 на вопрос, покрывает ли то «ДА»
 * карточки мест: «пока нет получим согласе востановим». Отсюда три обещания,
 * и каждое проверяется здесь поведением, а не текстом:
 *
 *   спрятано — карточка, фото путевых точек маршрута и обе раздачи кадра не
 *     отдают ни героя, ни кадра галереи партнёра; подписи с его именем нет;
 *   не удалено — строки на месте, с автором и ключом хранилища;
 *   восстановимо — обратная правка из хвоста миграции, выполненная как есть,
 *     возвращает кадры на карточку. Комментарий, обещающий возврат, без этой
 *     проверки был бы объявлением без исполнения (§10.09).
 *
 * Мок ответил бы на любой SQL, поэтому сцена разыгрывается на схеме baseline
 * прода плюс всех миграций; 1260 затем прогоняется ещё дважды по засеянным
 * строкам — так же, как она ляжет на прод, и повторно, как велит идемпотентность.
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
const MIGRATION = readFileSync(join(process.cwd(), 'migrations/1260_partner_photos_no_consent_hidden.sql'), 'utf-8');
const PARTNER = 'Местечко Камчатка';
const OWNER = 'владелец платформы';

/** Место с героем партнёра и двумя кадрами галереи: партнёра и владельца. */
const SPRINGS = { id: 'b1260000-0000-4000-8000-000000000001', ark: 'a1260000-0000-4000-8000-000000000001' };
/** Место с героем владельца — контроль: его 1260 не трогает. */
const VOLCANO = { id: 'b1260000-0000-4000-8000-000000000002', ark: 'a1260000-0000-4000-8000-000000000002' };
const ROUTE = 'c1260000-0000-4000-8000-000000000001';

const S3 = 'https://s3.example.test/bucket';
const heroUrl = (ark: string) => `${S3}/places/${ark}/hero.jpg`;
const galleryUrl = (ark: string, pos: number) => `${S3}/places/${ark}/g${pos}.jpg`;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Обратная правка — строки хвоста после «Вернуть», без «-- », как есть. */
function restoreSql(): string {
  const at = MIGRATION.indexOf('-- Вернуть');
  expect(at, 'в миграции нет обратной правки').toBeGreaterThan(-1);
  return MIGRATION.slice(at)
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('-- '))
    .map((l) => l.slice(3))
    .join('\n');
}

withPg('снимки партнёра без согласия: спрятаны, не удалены, восстановимы (1260)', () => {
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
      [VOLCANO, 'Корякская сопка (тест)', 'volcano'],
    ] as const) {
      await pool.query(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, $2, 53.4, 158.9, $3, $4, 'avachinsky', TRUE)`,
        [p.id, name, p.ark, type],
      );
    }
    await pool.query(
      `INSERT INTO ai_route_images (route_id, s3_url, s3_key, model, author, license, source_url)
       VALUES ($1, $2, 'photos/nalychevo/mestechko-kupalnya.jpg', 'manual-upload', $3,
               'с разрешения туроператора', 'https://vedarai.ru/operators/mestechko'),
              ($4, $5, 'migrations/photos/owner.jpg', 'manual-upload', $6, NULL, NULL)`,
      [SPRINGS.ark, heroUrl(SPRINGS.ark), PARTNER, VOLCANO.ark, heroUrl(VOLCANO.ark), OWNER],
    );
    await pool.query(
      `INSERT INTO place_gallery_photos (ark_id, position, s3_url, width, height, caption, author)
       VALUES ($1, 1, $2, 1200, 860, 'Евражка на перевале', $3),
              ($1, 2, $4, 1280, 720, 'Источники осенью', $5)`,
      [SPRINGS.ark, galleryUrl(SPRINGS.ark, 1), PARTNER, galleryUrl(SPRINGS.ark, 2), OWNER],
    );
    await pool.query(
      `INSERT INTO kamchatka_routes (id, category, title, zone, is_visible)
       VALUES ($1, 'trekking', 'Налычевская долина (тест)', 'avachinsky', TRUE)`,
      [ROUTE],
    );
    await pool.query(
      `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES
         ($1, $2, 0, 'waypoint'), ($1, $3, 1, 'waypoint')`,
      [ROUTE, SPRINGS.id, VOLCANO.id],
    );
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('до 1260 кадры партнёра на карточке — сцена поставлена верно', async () => {
    const c = await card(SPRINGS.id);
    expect(c.images.some((u) => u.startsWith(`/api/images/route/${SPRINGS.ark}`))).toBe(true);
    expect(c.images.some((u) => u.startsWith(`/api/images/place-gallery/${SPRINGS.ark}/1`))).toBe(true);
    expect(c.photoAttribution?.author).toBe(PARTNER);
    expect(await heroStatus(SPRINGS.ark)).toBe(302);
    expect(await galleryStatus(SPRINGS.ark, 1)).toBe(302);
  });

  it('1260 прячет кадры партнёра по автору и ничего не удаляет; повтор ничего не меняет', async () => {
    // Только строки сцены: миграции кладут и свои снимки к своим местам.
    const snapshot = async () => (await pool.query(
      `SELECT 'hero' AS t, route_id::text AS ark, NULL::int AS pos, model, author, s3_key, s3_url, NULL AS hidden_reason
         FROM ai_route_images WHERE route_id = ANY($1::uuid[])
       UNION ALL
       SELECT 'gallery', ark_id::text, position, NULL, author, s3_key, s3_url, hidden_reason
         FROM place_gallery_photos WHERE ark_id = ANY($1::uuid[])
       ORDER BY 1, 2, 3`,
      [[SPRINGS.ark, VOLCANO.ark]],
    )).rows;

    await pool.query(MIGRATION);
    const first = await snapshot();
    await pool.query(MIGRATION);
    expect(await snapshot()).toEqual(first);

    const heroes = first.filter((r) => r.t === 'hero');
    const gallery = first.filter((r) => r.t === 'gallery');
    expect(heroes).toHaveLength(2);
    expect(gallery).toHaveLength(2);
    // Автор и адрес в хранилище остались — вернуть будет что.
    expect(heroes.find((r) => r.ark === SPRINGS.ark)).toMatchObject({
      model: 'partner-no-consent', author: PARTNER, s3_url: heroUrl(SPRINGS.ark),
    });
    expect(heroes.find((r) => r.ark === VOLCANO.ark)).toMatchObject({ model: 'manual-upload', author: OWNER });
    expect(gallery.find((r) => r.pos === 1)?.hidden_reason).toMatch(/согласия на показ на карточках мест пока нет/);
    expect(gallery.find((r) => r.pos === 1)?.s3_url).toBe(galleryUrl(SPRINGS.ark, 1));
    expect(gallery.find((r) => r.pos === 2)?.hidden_reason).toBeNull();
  });

  it('карточка места: ни героя, ни кадра партнёра, ни его имени в подписи; кадр владельца остался', async () => {
    const c = await card(SPRINGS.id);
    expect(c.images).toHaveLength(1);
    expect(c.images[0]).toMatch(new RegExp(`^/api/images/place-gallery/${SPRINGS.ark}/2\\?v=\\d+$`));
    // Первым кадром — оставшийся кадр галереи, а не адрес спрятанного героя:
    // при одном кадре PlaceHero берёт именно photoUrl.
    expect(c.photoUrl).toBe(c.images[0]);
    expect(c.photoCount).toBe(1);
    expect(c.photoAttribution).toBeNull();
    expect(Object.values(c.photoCredits)).toEqual([OWNER]);
    expect(JSON.stringify(c)).not.toContain(PARTNER);
  });

  it('фото маршрута из точек пути не берут спрятанное', async () => {
    const urls = await routePhotos();
    expect(urls.some((u) => u.includes(SPRINGS.ark) && u.startsWith('/api/images/route/'))).toBe(false);
    expect(urls.some((u) => u.startsWith(`/api/images/place-gallery/${SPRINGS.ark}/1`))).toBe(false);
    expect(urls.some((u) => u.startsWith(`/api/images/place-gallery/${SPRINGS.ark}/2`))).toBe(true);
    expect(urls.some((u) => u.startsWith(`/api/images/route/${VOLCANO.ark}`))).toBe(true);
  });

  it('раздача по прямому адресу: спрятанное — 404, остальное отдаётся', async () => {
    expect(await heroStatus(SPRINGS.ark)).toBe(404);
    expect(await galleryStatus(SPRINGS.ark, 1)).toBe(404);
    expect(await galleryStatus(SPRINGS.ark, 2)).toBe(302);
    expect(await heroStatus(VOLCANO.ark)).toBe(302);
  });

  it('обратная правка из хвоста миграции возвращает кадры на карточку', async () => {
    await pool.query(restoreSql());
    const c = await card(SPRINGS.id);
    expect(c.images[0]).toMatch(new RegExp(`^/api/images/route/${SPRINGS.ark}`));
    expect(c.images).toHaveLength(3);
    expect(c.photoAttribution?.author).toBe(PARTNER);
    expect(await heroStatus(SPRINGS.ark)).toBe(302);
    expect(await galleryStatus(SPRINGS.ark, 1)).toBe(302);
  });
});
