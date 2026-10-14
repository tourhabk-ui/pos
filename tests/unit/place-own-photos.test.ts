// @vitest-environment node
/**
 * Карточка места показывает только наши снимки (14.10, слово владельца:
 * «Только используй наши фотографии») — вызовом загрузчика карточки и
 * страницы места на подменённой базе.
 *
 * places.photo_url и places.images собраны импортом с посторонних сайтов. До
 * 14.10 герой брал их запасом, сырой список вытеснял наш снимок из галереи,
 * миниатюра «Рядом» брала чужую ссылку, а превью ссылки и JSON-LD ставили её
 * даже впереди своего снимка.
 */
import React, { type ReactElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NEARBY_PLACES_SQL } from '@/lib/places/nearby';

const query = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/places/aliases', async (orig) => ({
  ...(await orig<typeof import('@/lib/places/aliases')>()),
  resolveMergedTarget: vi.fn(async () => null),
}));
vi.mock('@/app/places/[id]/_PlaceDetailClient', () => ({ default: () => null }));
vi.mock('@/components/places/PlaceSOS', () => ({ default: () => null }));

import { loadPlaceDetail } from '@/lib/places/place-detail';
import PlaceDetailPage, { generateMetadata } from '@/app/places/[id]/page';
import { JsonLd } from '@/components/seo/JsonLd';
import { defaultOgImages } from '@/lib/seo/og-image';

const ARK = '9f1c2d3e-0000-4000-8000-000000000001';
const FOREIGN = 'https://visitkamchatka.ru/upload/iblock/morzh.jpg';
const FOREIGN_2 = 'https://kamchatka.travel/img/morzh-2.jpg';

/** Строка места: по умолчанию — наш снимок есть, а в прежних полях только чужие ссылки. */
function placeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'morzhovyj', ark_id: ARK, place_pk: 'morzhovyj', slug: 'mys-morzhovyj', name: 'Моржовый',
    location_type: 'cape', lat: '52.95131', lng: '158.71249',
    photo_count: 1, photo_version: 1700000000, photo_url: FOREIGN, images: [FOREIGN, FOREIGN_2], gallery_urls: [],
    ...over,
  };
}

let row: Record<string, unknown>;
let nearby: Array<Record<string, unknown>>;

beforeEach(() => {
  row = placeRow();
  nearby = [{ id: 'b1', slug: 'buhta-morzhovaya', name: 'Бухта Моржовая', location_type: 'bay', lat: '52.96', lng: '158.72',
    photo_url: FOREIGN, thumb_url: null, distance_km: 2 }];
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql === NEARBY_PLACES_SQL) return { rows: nearby };
    if (/SELECT ark_id::text AS ark_id, slug FROM places/.test(sql)) return { rows: [{ ark_id: ARK, slug: 'mys-morzhovyj' }] };
    if (/FROM places p/.test(sql) && /WHERE \(p\.ark_id::text = \$1/.test(sql)) return { rows: [row] };
    return { rows: [] };
  });
});

async function card() {
  const res = await loadPlaceDetail(ARK, { countView: false });
  expect(res.status).toBe(200);
  return res.body.data as { photoUrl: string | null; images: string[]; nearby: Array<{ thumbUrl: string | null }> };
}

describe('загрузчик карточки: только наши снимки', () => {
  it('наш снимок есть — герой и галерея только из него; две чужие ссылки его не вытесняют', async () => {
    const d = await card();
    expect(d.photoUrl).toBe(`/api/images/route/${ARK}?v=1700000000`);
    expect(d.images).toEqual([`/api/images/route/${ARK}?v=1700000000`]);
    expect(JSON.stringify(d)).not.toContain('visitkamchatka.ru');
  });

  it('своего снимка нет, в прежних полях только чужие — героя нет (заглушка по типу), галерея пуста', async () => {
    row = placeRow({ photo_count: 0 });
    const d = await card();
    expect(d.photoUrl).toBeNull();
    expect(d.images).toEqual([]);
  });

  it('в прежних полях наши адреса — их и показываем, по порядку, без чужих', async () => {
    row = placeRow({ photo_count: 0, photo_url: FOREIGN, images: [FOREIGN, '/images/places/morzh-1.webp', '/images/places/morzh-2.webp'] });
    const d = await card();
    expect(d.photoUrl).toBe('/images/places/morzh-1.webp');
    expect(d.images).toEqual(['/images/places/morzh-1.webp', '/images/places/morzh-2.webp']);
  });

  it('своя галерея есть — герой и галерея, как прежде', async () => {
    row = placeRow({ gallery_urls: [`/api/images/place-gallery/${ARK}/1`, `/api/images/place-gallery/${ARK}/2`] });
    const d = await card();
    expect(d.images).toEqual([`/api/images/route/${ARK}?v=1700000000`, `/api/images/place-gallery/${ARK}/1`, `/api/images/place-gallery/${ARK}/2`]);
  });

  it('«Рядом»: своего снимка у соседа нет — миниатюры нет, чужая ссылка не подставляется', async () => {
    expect((await card()).nearby[0].thumbUrl).toBeNull();
    nearby = [{ ...nearby[0], thumb_url: '/api/images/route/b1?v=1' }];
    expect((await card()).nearby[0].thumbUrl).toBe('/api/images/route/b1?v=1');
  });
});

/** Узел JSON-LD места в дереве страницы. */
function jsonLdOf(node: ReactNode): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) { const f = jsonLdOf(n); if (f) return f; }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  const el = node as ReactElement<{ data?: Record<string, unknown>; children?: ReactNode }>;
  if (el.type === JsonLd && el.props.data?.['@type'] === 'TouristAttraction') return el.props.data;
  return jsonLdOf(el.props.children);
}

describe('страница места: превью ссылки и разметка — только наш снимок, свой первым', () => {
  const params = () => Promise.resolve({ id: 'mys-morzhovyj' });

  it('og:image — наш снимок места, хотя в photo_url лежит чужая ссылка', async () => {
    row = placeRow({ real_photo: `/api/images/route/${ARK}` });
    const meta = await generateMetadata({ params: params() });
    expect((meta.openGraph?.images as Array<{ url: string }>)[0].url).toBe(`/api/images/route/${ARK}`);
  });

  it('своего снимка нет — превью картинкой сайта, а не чужой ссылкой', async () => {
    row = placeRow({ real_photo: null, photo_count: 0 });
    const meta = await generateMetadata({ params: params() });
    expect(meta.openGraph?.images).toEqual(defaultOgImages());
  });

  it('JSON-LD: image — наш снимок абсолютным адресом; своего нет — поля image нет', async () => {
    row = placeRow({ has_real_photo: true });
    const ld = jsonLdOf(await PlaceDetailPage({ params: params() }));
    expect(ld).not.toBeNull();
    expect((ld!.image as Array<{ url: string }>)[0].url).toMatch(new RegExp(`/api/images/route/${ARK}$`));
    expect(JSON.stringify(ld)).not.toContain('visitkamchatka.ru');

    row = placeRow({ has_real_photo: false, photo_count: 0 });
    const bare = jsonLdOf(await PlaceDetailPage({ params: params() }));
    expect(bare).not.toBeNull();
    expect(bare!.image).toBeUndefined();
  });
});
