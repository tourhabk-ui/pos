/**
 * Снимки туров на МЕСТАХ без собственного фото (владелец 21.11: «и на местах
 * тоже фото не только маршрутах»; согласие и лицензия не нужны — «делай без
 * их согласия», 20.11).
 *
 * Судится: связь — только записанная (главное место тура или точка пути
 * маршрута тура без своего главного места; не «рядом», не по названию);
 * согласие партнёра не условие ни для снимков туров, ни для кадров галереи
 * партнёра; страница места берёт туры, только когда своего кадра нет;
 * подпись ведёт на страницу партнёра; на плитке /places подпись стоит ВНЕ
 * ссылки на место, alt — название места, первые плитки — без ленивой
 * загрузки. Отбор на PostgreSQL — tests/integration/route-tour-photos.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, error: null, localOnly: false, toggle: async () => {} }),
  wishlistLabel: () => 'В избранное',
  WISHLIST_LOCAL_ONLY_HINT: '',
}));
vi.mock('@/components/routes/useAnchor', () => ({
  useAnchor: () => ({ anchor: { lat: 53.0195, lng: 158.6505 }, label: 'от Петропавловска', requestGeo: () => {} }),
}));

import { PLACE_TOUR_PHOTOS_SQL, PLACE_CARD_TOUR_PHOTOS_SQL, placeTourLinksSql } from '@/lib/places/tour-photos';
import { galleryShownSql } from '@/lib/places/gallery-shown';
import { hasNoOwnPhoto, tourPhotoCreditsOf, tourPhotoRightsOf } from '@/lib/places/place-detail';
import PlaceCard from '@/components/routes/PlaceCard';
import type { RouteItem } from '@/components/routes/RouteCard';

beforeAll(() => {
  class IO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { IntersectionObserver: typeof IO }).IntersectionObserver = IO;
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ zones: [] }), { status: 200 })) as typeof fetch;
});
afterEach(cleanup);

describe('связь тура с местом — только записанная', () => {
  const links = placeTourLinksSql('$1');
  it('главное место тура или точка пути маршрута тура; не «рядом», не по названию', () => {
    expect(links).toContain('ot_m.main_place_id = ($1)::text');
    expect(links).toContain('ot_r.route_id::text = kr_r.id::text');
    expect(links).toContain("= 'waypoint'");
    // Тур со своим главным местом снимает его, а не соседнюю точку пути.
    expect(links).toContain("NULLIF(btrim(ot_r.main_place_id), '') IS NULL");
    for (const sql of [links, PLACE_TOUR_PHOTOS_SQL, PLACE_CARD_TOUR_PHOTOS_SQL]) {
      expect(sql).not.toMatch(/similarity|ILIKE|LIKE '%|levenshtein/i);
    }
  });

  it('согласия и лицензии не требуется; автор — gallery_credits или имя партнёра; по алфавиту, без рейтингов', () => {
    for (const sql of [PLACE_TOUR_PHOTOS_SQL, PLACE_CARD_TOUR_PHOTOS_SQL]) {
      expect(sql).not.toContain('partner_material_consents');
      expect(sql).not.toMatch(/license/i);
      expect(sql).toContain(`COALESCE(NULLIF(btrim(COALESCE(pa.gallery_credits, '{}'::jsonb)->>x.url), ''), btrim(pa.name)) AS author`);
      expect(sql).toContain('is_published = true');
      expect(sql).not.toMatch(/rating|review_count|is_verified|promot|paid/i);
    }
    expect(PLACE_TOUR_PHOTOS_SQL).toMatch(/ORDER BY partner_name, partner_id/);
    expect(PLACE_CARD_TOUR_PHOTOS_SQL).toMatch(/ORDER BY c\.aid, pa\.name, pa\.id/);
  });

  it('плитка: снимок тура только у места без своего главного кадра и без кадра галереи', () => {
    expect(PLACE_CARD_TOUR_PHOTOS_SQL).toMatch(/NOT EXISTS \(SELECT 1 FROM ai_route_images ai/);
    expect(PLACE_CARD_TOUR_PHOTOS_SQL).toMatch(/NOT EXISTS \(SELECT 1 FROM place_gallery_photos g/);
  });
});

describe('кадр галереи партнёра — без согласия (21.11)', () => {
  it('условие показа — только ручная причина скрытия', () => {
    expect(galleryShownSql('g')).toBe('(g.hidden_reason IS NULL)');
    expect(galleryShownSql('g')).not.toContain('partner_material_consents');
  });
});

describe('страница места: туры — только когда своего фото нет', () => {
  const bare = { photo_count: 0, gallery_urls: [], photo_url: null, images: null };
  it('нет ни героя, ни галереи, ни своего адреса — да; любое своё — нет', () => {
    expect(hasNoOwnPhoto(bare)).toBe(true);
    expect(hasNoOwnPhoto({ ...bare, photo_count: 1 })).toBe(false);
    expect(hasNoOwnPhoto({ ...bare, gallery_urls: ['/api/images/place-gallery/a/1'] })).toBe(false);
    expect(hasNoOwnPhoto({ ...bare, images: ['/api/images/s3/photos/x.jpg'] })).toBe(false);
    // Чужая ссылка своим фото не считается.
    expect(hasNoOwnPhoto({ ...bare, photo_url: 'https://example.com/x.jpg' })).toBe(true);
  });

  it('подпись — имя автора, ссылка — страница партнёра; лицензии не выдумывается', () => {
    const shots = [{
      url: '/t.jpg', tourTitle: 'Тур', tourSlug: 't', placeName: null,
      credit: { name: 'Край Вулканов', href: '/operators/volcanoesland', kind: 'partner' as const },
    }];
    expect(tourPhotoCreditsOf(shots)).toEqual({ '/t.jpg': 'Край Вулканов' });
    expect(tourPhotoRightsOf(shots)).toEqual({ '/t.jpg': { license: null, licenseUrl: null, sourceUrl: '/operators/volcanoesland' } });
  });
});

describe('плитка места в /places: снимок тура с подписью', () => {
  const place = (extra: Partial<RouteItem> = {}): RouteItem => ({
    id: '4dd86a74-d010-4ff4-81ad-23af3ba966a5', kind: 'place', urlSlug: 'dolina-geyzerov', category: 'geysers',
    locationType: 'geyser', title: 'Долина гейзеров', description: '', lat: 54.43, lng: 160.14,
    difficulty: null, durationDays: null, placeTours: null, ...extra,
  });

  it('подпись — ссылка на партнёра ВНЕ ссылки на место; alt — название места', () => {
    const { container } = render(<PlaceCard route={place({
      imageUrl: '/t.jpg', photoAlt: 'Долина гейзеров',
      photoCredit: { name: 'Край Вулканов', href: '/operators/volcanoesland', kind: 'partner' },
    })} />);
    const a = container.querySelector('[data-testid="place-card-photo-credit"] a');
    expect(a?.getAttribute('href')).toBe('/operators/volcanoesland');
    expect(a?.textContent).toBe('Край Вулканов');
    expect(a?.closest('a[href^="/places/"]')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Долина гейзеров');
  });

  it('без снимка — ни картинки, ни подписи', () => {
    const { container } = render(<PlaceCard route={place()} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="place-card-photo-credit"]')).toBeNull();
  });

  it('первые плитки — без ленивой загрузки (LCP), остальные — лениво', () => {
    const { container: a } = render(<PlaceCard route={place({ imageUrl: '/t.jpg' })} eager />);
    expect(a.querySelector('img')?.getAttribute('loading')).toBe('eager');
    cleanup();
    const { container: b } = render(<PlaceCard route={place({ imageUrl: '/t.jpg' })} />);
    expect(b.querySelector('img')?.getAttribute('loading')).toBe('lazy');
  });
});
