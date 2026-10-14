// @vitest-environment node
/**
 * « | Ведар» снимается, когда заголовок с ним не помещается в выдачу
 * (перепись sitemap 14.10, прогон 7).
 *
 * У четырёх маршрутов и места «Командорский государственный природный
 * биосферный заповедник» заголовок выходил за 65 знаков только из-за суффикса
 * шаблона layout: выдача резала бы его посреди слова «Ведар». Имя сайта поиск
 * показывает отдельно, поэтому такой заголовок отдаётся `absolute` — без
 * суффикса, а короткий по-прежнему получает бренд.
 *
 * Правило — вызовом `brandedTitle` на границе, поверхности — вызовом
 * generateMetadata карточек маршрута и места на настоящих длинных именах.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { brandedTitle, BRAND_SUFFIX, TITLE_LIMIT } from '@/lib/seo/title-fit';

const query = vi.fn();
// React.cache живёт только в серверной сборке React; в тесте — тождество.
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/lib/database', () => ({ query: (sql: string, params?: unknown[]) => query(sql, params) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/app/routes/[id]/_RouteDetailClient', () => ({ default: () => null }));
vi.mock('@/components/routes/CategoryPage', () => ({ default: () => null }));
vi.mock('@/app/places/[id]/_PlaceDetailClient', () => ({ default: () => null }));

/** Что покажет выдача: к строке шаблон layout дописывает бренд, к absolute — нет. */
function shown(title: unknown): string {
  if (title && typeof title === 'object' && 'absolute' in title) return String((title as { absolute: string }).absolute);
  return `${String(title)}${BRAND_SUFFIX}`;
}

// Тело в фигурных скобках: функцию, возвращённую из beforeEach, vitest зовёт как
// уборку после теста — `mockReset()` возвращает сам мок, и его позвали бы без SQL.
beforeEach(() => { query.mockReset(); });

describe('brandedTitle — бренд, пока помещается', () => {
  it('ровно в пределе — строка, шаблон допишет бренд', () => {
    const t = 'а'.repeat(TITLE_LIMIT - BRAND_SUFFIX.length);
    expect(brandedTitle(t)).toBe(t);
    expect(shown(brandedTitle(t))).toHaveLength(TITLE_LIMIT);
  });

  it('на знак длиннее — без бренда, само название не тронуто', () => {
    const t = 'а'.repeat(TITLE_LIMIT - BRAND_SUFFIX.length + 1);
    expect(brandedTitle(t)).toEqual({ absolute: t });
  });

  it('название длиннее предела и без бренда — не режется', () => {
    const t = 'б'.repeat(TITLE_LIMIT + 10);
    expect(brandedTitle(t)).toEqual({ absolute: t });
  });
});

const ROUTE_ID = '9528254b-eb40-4132-ab75-4d12ee0ba8d2';

function routeRows(title: string) {
  return async (sql: string) => {
    if (sql.includes('FROM kamchatka_routes WHERE COALESCE(ark_id, id)::text = $1')) return { rows: [{ kind: 'route' }] };
    if (sql.includes('FROM agent_route_knowledge k')) {
      return { rows: [{
        id: ROUTE_ID, category: 'вулканы', title,
        description: 'Пеший маршрут по окрестностям вулкана: лавовые поля, шлаковые конусы и ночёвка у ручья.',
        lat: '56.0', lng: '160.8', source_url: null, payload: {},
        location_type: null, activity_type: 'trekking', has_real_photo: false,
        kr_zone: null, distance_km: '18', duration_hours: null, kr_duration_days: '2',
        elevation_gain_m: '900', kr_difficulty: null, kr_season: null, mchs_registration_required: true,
      }] };
    }
    return { rows: [] };
  };
}

describe('карточка маршрута', { timeout: 30_000 }, () => {
  async function meta(title: string) {
    query.mockImplementation(routeRows(title));
    const { generateMetadata } = await import('@/app/routes/[id]/page');
    return generateMetadata({ params: Promise.resolve({ id: ROUTE_ID }) });
  }

  it('длинное имя: « — маршрут» остаётся, бренд снят, в выдачу помещается', async () => {
    const name = 'Путешествие вокруг окрестностей вулкана Бакенинг';
    const m = await meta(name);
    expect(m.title).toEqual({ absolute: `${name} — маршрут` });
    expect(shown(m.title).length).toBeLessThanOrEqual(TITLE_LIMIT);
    // Превью в мессенджере — тот же заголовок строкой: шаблон layout к og:title не применяется.
    expect(m.openGraph?.title).toBe(`${name} — маршрут`);
  });

  it('короткое имя — с полным хвостом и брендом, как прежде', async () => {
    const m = await meta('Вулкан Горелый');
    expect(m.title).toBe('Вулкан Горелый — маршрут на Камчатке');
    expect(shown(m.title)).toBe('Вулкан Горелый — маршрут на Камчатке | Ведар');
  });
});

describe('карточка места', { timeout: 30_000 }, () => {
  async function meta(name: string) {
    query.mockResolvedValue({ rows: [{
      name, essence: 'Заповедник на Командорских островах: лежбища котиков и сивучей, птичьи базары.',
      description: null, photo_url: null, location_type: 'reserve', images: null,
      slug: 'mesto', ark_id: '0f2c8a9e-2222-4c4c-9d9d-000000001410', zone: null, best_season: null,
      altitude_m: null, hazard_types: null, registration_required: false, profile_source: null,
      is_open: null, real_photo: null,
    }] });
    const { generateMetadata } = await import('@/app/places/[id]/page');
    return generateMetadata({ params: Promise.resolve({ id: 'mesto' }) });
  }

  it('имя на 60 знаков: хвоста нет, бренд снят — заголовок помещается целиком', async () => {
    const name = 'Командорский государственный природный биосферный заповедник';
    const m = await meta(name);
    expect(m.title).toEqual({ absolute: name });
    expect(shown(m.title).length).toBeLessThanOrEqual(TITLE_LIMIT);
  });

  it('короткое имя — заголовок из placeTitle, с хвостом и брендом', async () => {
    const m = await meta('Вулкан Ксудач');
    // Сезона и опасностей в данных нет — хвост только «как добраться» (lib/seo/place-meta).
    expect(m.title).toBe('Вулкан Ксудач: как добраться');
    expect(shown(m.title)).toBe('Вулкан Ксудач: как добраться | Ведар');
  });
});
