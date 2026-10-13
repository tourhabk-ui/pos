// @vitest-environment node
/**
 * Метаданные маршрута не падают на форме payload (перепись sitemap 13.10).
 *
 * Два маршрута из sitemap отвечали Googlebot 500, браузеру — 200 без title,
 * description и canonical. Проба с прода (probe-url 786) показала причину: у
 * обоих `payload.season` — МАССИВ, а карточка читала его `as string`, и
 * routeFactsLine звал `.toLowerCase()`. Здесь generateMetadata самой страницы
 * зовётся на строке «из базы» с массивом сезона, объектами вместо адресов фото
 * и смешанным best_months — и обязан вернуть полные метаданные.
 */
import { describe, it, expect, vi } from 'vitest';
import { payloadText, payloadStrings } from '@/lib/routes/payload-text';
import { routeFactsLine } from '@/lib/seo/place-meta';

const ROUTE_ID = '3f0b5a2e-1111-4c4c-9d9d-000000001310';
const SLUG = 'avachinskij-pereval-baza-3-vulkana';

let viewPayload: Record<string, unknown> = {};
const query = vi.fn(async (sql: string) => {
  if (sql.includes('FROM kamchatka_routes WHERE slug = $1')) return { rows: [{ id: ROUTE_ID, kind: 'route', ord: 0 }] };
  if (sql.includes('FROM agent_route_knowledge k')) {
    return { rows: [{
      id: ROUTE_ID, category: 'вулканы', title: 'Авачинский перевал — база «3 вулкана»',
      description: 'Подход к базе под Авачинским и Корякским вулканами по грунтовке, ночёвка в домиках.',
      lat: '53.25', lng: '158.79', source_url: null, payload: viewPayload,
      location_type: null, activity_type: 'hiking', has_real_photo: false,
      kr_zone: null, distance_km: '12', duration_hours: '6', kr_duration_days: null,
      elevation_gain_m: '700', kr_difficulty: null, kr_season: null, mchs_registration_required: false,
    }] };
  }
  return { rows: [] };
});
// React.cache живёт только в серверной сборке React; в тесте — тождество.
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/lib/database', () => ({ query: (sql: string) => query(sql) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/app/routes/[id]/_RouteDetailClient', () => ({ default: () => null }));
vi.mock('@/components/routes/CategoryPage', () => ({ default: () => null }));

async function meta(payload: Record<string, unknown>) {
  viewPayload = payload;
  const { generateMetadata } = await import('@/app/routes/[id]/page');
  return generateMetadata({ params: Promise.resolve({ id: SLUG }) });
}

describe('payloadText / payloadStrings: тип проверяется, а не обещается', () => {
  it.each([
    ['лето', 'лето'],
    ['  ', null],
    [['summer', 'autumn'], 'summer, autumn'],
    [['июль', 7, null, ' август '], 'июль, август'],
    [[], null],
    [[1, 2], null],
    [3, null],
    [{ from: 'июль' }, null],
    [null, null],
    [undefined, null],
  ])('%j → %j', (raw, want) => {
    expect(payloadText(raw)).toBe(want);
  });

  it('список строк: нестроковое отбрасывается, пусто — null', () => {
    expect(payloadStrings(['/a.jpg', { url: '/b.jpg' }, '', 5])).toEqual(['/a.jpg']);
    expect(payloadStrings([{ url: '/b.jpg' }])).toBeNull();
    expect(payloadStrings('/a.jpg')).toBeNull();
  });

  it('сезон списком переводится по каждому элементу', () => {
    const line = routeFactsLine({ title: 't', zone: null, distanceKm: null, durationHours: null, durationDays: null,
      elevationGainM: null, difficulty: null, season: 'summer, autumn', mchsRequired: false, description: null });
    expect(line).toBe('сезон лето, осень');
  });
});

describe('generateMetadata маршрута на «грязном» payload', () => {
  it('сезон массивом — метаданные полные, а не исключение', async () => {
    const m = await meta({ season: ['summer', 'autumn'], difficulty: 'medium' });
    expect(m.alternates?.canonical).toBe(`https://vedarai.ru/routes/${SLUG}`);
    expect(String(m.title)).toMatch(/Авачинский перевал/);
    expect(String(m.description)).toMatch(/сезон лето, осень/);
    expect(String(m.description)).toMatch(/сложность средняя/);
  });

  it('фото объектами и смешанные месяцы — превью только из строковых адресов', async () => {
    const m = await meta({ season: 'лето', photos: [{ url: '/x.jpg' }, 42], best_months: [6, 'июль'] });
    const images = (m.openGraph?.images ?? []) as Array<{ url: unknown }>;
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) expect(typeof img.url).toBe('string');
  });

  it('строковые фото доходят до превью', async () => {
    const m = await meta({ photos: ['https://s3.twcstorage.ru/x/route.jpg'] });
    const images = (m.openGraph?.images ?? []) as Array<{ url: unknown }>;
    expect(images[0]?.url).toBe('https://s3.twcstorage.ru/x/route.jpg');
  });
});
