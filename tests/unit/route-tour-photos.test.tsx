/**
 * Снимки туров на карточках маршрутов и подпись автора со ссылкой (21.11).
 *
 * Владелец: «нет фото Ганальские востряки — нужно ставить из туров, но чтоб
 * по подписи можно было перейти на страницу владельца фото: если это Андрей
 * Запорожец — на его страницу, если турист — на её фотоленту, типа маленькой
 * инсты, но с переходом на само место».
 *
 * Судится: куда ведёт подпись (партнёр / лента / текст), что снимок без
 * автора и без разрешения не ставится, что связь — только записанная (не по
 * похожести названий), что фото без лицензии в ленту не попадает, что
 * подпись на карточке стоит ВНЕ ссылки на маршрут и что alt — название места.
 * Отбор на настоящем PostgreSQL — tests/integration/route-tour-photos.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, localOnly: false, toggle: () => {} }),
  wishlistLabel: () => 'В избранное',
  WISHLIST_LOCAL_ONLY_HINT: '',
}));

import { photoCreditFor, authorFeedPath, authorFeedSlug, authorFeedEnabled } from '@/lib/media/author-credit';
import { toRouteTourPhotos, ROUTE_TOUR_PHOTOS_SQL, ROUTE_CARD_TOUR_PHOTOS_SQL, routeTourLinksSql } from '@/lib/routes/tour-photos';
import { AUTHOR_FEED_SQL, groupFeeds } from '@/lib/media/author-feed';
import { PLACE_CARDS_CONSENT_FROM } from '@/lib/legal/partner-materials-consent';
import RoutePathCard from '@/components/routes/RoutePathCard';
import { AuthorPhotoGrid } from '@/components/media/AuthorPhotoGrid';

afterEach(cleanup);

const ZAP = { name: 'Андрей Запорожец', slug: 'andrey-zaporozhets', isPublic: true };

describe('подпись автора: куда ведёт', () => {
  it('автор — сам партнёр → страница партнёра', () => {
    expect(photoCreditFor({ author: 'Андрей Запорожец', partner: ZAP, feedEligible: true, feedEnabled: true }))
      .toEqual({ name: 'Андрей Запорожец', href: '/operators/andrey-zaporozhets', kind: 'partner' });
  });

  it('подпись «Партнёр. Место съёмки» — тоже партнёр', () => {
    expect(photoCreditFor({ author: 'Андрей Запорожец. Кратер Чаша', partner: ZAP, feedEligible: true, feedEnabled: true }))
      .toEqual({ name: 'Андрей Запорожец. Кратер Чаша', href: '/operators/andrey-zaporozhets', kind: 'partner' });
  });

  it('партнёр без открытой страницы → имя текстом, не ссылка на 404', () => {
    expect(photoCreditFor({ author: 'Андрей Запорожец', partner: { ...ZAP, isPublic: false }, feedEligible: true, feedEnabled: true }))
      .toEqual({ name: 'Андрей Запорожец', href: null, kind: 'text' });
  });

  it('автор — человек с лентой → его фотолента; без ленты или с выключенным флагом → текст', () => {
    expect(photoCreditFor({ author: 'Алина Гусакова', partner: ZAP, feedEligible: true, feedEnabled: true }))
      .toEqual({ name: 'Алина Гусакова', href: '/foto/alina-gusakova', kind: 'author_feed' });
    expect(photoCreditFor({ author: 'Алина Гусакова', feedEligible: false, feedEnabled: true })?.href).toBeNull();
    expect(photoCreditFor({ author: 'Алина Гусакова', feedEligible: true, feedEnabled: false })?.href).toBeNull();
  });

  it('автора нет — подписи нет', () => {
    expect(photoCreditFor({ author: '  ', partner: ZAP, feedEligible: true, feedEnabled: true })).toBeNull();
    expect(photoCreditFor({ author: null, feedEligible: true, feedEnabled: true })).toBeNull();
  });

  it('адрес ленты — только транслит имени: без цифр учётной записи, без контактов', () => {
    expect(authorFeedPath('Алина Гусакова')).toBe('/foto/alina-gusakova');
    expect(authorFeedSlug('!!!')).toBeNull();
    expect(authorFeedPath('Алина Гусакова')).toMatch(/^\/foto\/[a-z-]+$/);
  });

  it('флаг AUTHOR_PHOTO_FEED=off выключает ленту', () => {
    expect(authorFeedEnabled({})).toBe(true);
    expect(authorFeedEnabled({ AUTHOR_PHOTO_FEED: 'off' })).toBe(false);
  });
});

describe('снимок тура на маршруте: только с автором и разрешением', () => {
  const row = (url: string, author: string | null) => ({
    url, author, partner_name: 'Андрей Запорожец', partner_slug: 'andrey-zaporozhets', partner_public: true,
    tour_title: 'Ганальские Востряки', tour_slug: 'zaporozhets-ganalskie-vostryaki', place_name: 'Ганальские востряки',
  });

  it('строка без автора отбрасывается, дубль адреса — тоже', () => {
    const out = toRouteTourPhotos([row('/a.jpg', null), row('/b.jpg', 'Андрей Запорожец'), row('/b.jpg', 'Андрей Запорожец')], { feedEnabled: true });
    expect(out.map((p) => p.url)).toEqual(['/b.jpg']);
    expect(out[0].credit.href).toBe('/operators/andrey-zaporozhets');
    expect(out[0].placeName).toBe('Ганальские востряки');
  });

  it('разрешение — подписанное согласие версии, что называет карточки маршрутов; автор — из gallery_credits', () => {
    for (const sql of [ROUTE_TOUR_PHOTOS_SQL, ROUTE_CARD_TOUR_PHOTOS_SQL]) {
      expect(sql).toContain(`pmc.text_version >= '${PLACE_CARDS_CONSENT_FROM}'`);
      expect(sql).toContain('pmc.revoked_at IS NULL');
      expect(sql).toMatch(/NULLIF\(btrim\(COALESCE\(pa\.gallery_credits, '\{\}'::jsonb\)->>x\.url\), ''\) IS NOT NULL/);
      expect(sql).toContain('is_published = true');
    }
  });

  it('связь — только записанная: тур на маршрут или главное место тура — точка пути; не «рядом», не по названию', () => {
    const links = routeTourLinksSql('$1');
    expect(links).toContain('ot_r.route_id');
    expect(links).toContain('ot_m.main_place_id = p_m.id::text');
    expect(links).toContain("= 'waypoint'");
    for (const sql of [links, ROUTE_TOUR_PHOTOS_SQL, ROUTE_CARD_TOUR_PHOTOS_SQL]) {
      expect(sql).not.toMatch(/similarity|ILIKE|LIKE '%|levenshtein/i);
    }
  });

  it('порядок партнёров — по имени, без рейтингов и оплаты', () => {
    expect(ROUTE_TOUR_PHOTOS_SQL).toMatch(/ORDER BY partner_name, partner_id/);
    expect(ROUTE_CARD_TOUR_PHOTOS_SQL).toMatch(/ORDER BY c\.rid, pa\.name, pa\.id/);
    for (const sql of [ROUTE_TOUR_PHOTOS_SQL, ROUTE_CARD_TOUR_PHOTOS_SQL]) expect(sql).not.toMatch(/rating|review_count|is_verified|promot|paid/i);
  });
});

describe('фотолента: фото без лицензии не показывается', () => {
  it('в SQL у обоих источников снимков мест лицензия обязательна, внешний источник исключён', () => {
    const licenseChecks = AUTHOR_FEED_SQL.match(/NULLIF\(btrim\((ai|g)\.license\), ''\) IS NOT NULL/g) ?? [];
    expect(licenseChecks).toHaveLength(2);
    expect(AUTHOR_FEED_SQL).toMatch(/NULLIF\(btrim\(ai\.source_url\), ''\) IS NULL/);
    expect(AUTHOR_FEED_SQL).toMatch(/NULLIF\(btrim\(g\.source_url\), ''\) IS NULL/);
    expect(AUTHOR_FEED_SQL).toContain('g.partner_id IS NULL');
  });

  it('в ленте только имя автора, никаких контактов', () => {
    expect(AUTHOR_FEED_SQL).not.toMatch(/email|phone|telegram|user_id|contact/i);
  });

  it('строка без лицензии в ленту не попадает; с лицензией — со ссылкой на место', () => {
    const feeds = groupFeeds([
      { author: 'Алина Гусакова', url: '/api/images/route/1?size=card', alt: 'Лавовые пещеры', href: '/places/lavovye', license: null },
      { author: 'Алина Гусакова', url: '/api/images/route/2?size=card', alt: 'Вачкажец', href: '/places/vachkazhets', license: '  ' },
      { author: 'Мария Тестова', url: '/api/images/route/3?size=card', alt: 'Озеро', href: '/places/ozero', license: 'CC BY 4.0' },
      { author: 'Мария Тестова', url: '/x.jpg', alt: 'Маршрут', href: 'route:test-route', license: 'CC BY 4.0' },
    ]);
    expect(feeds.has('alina-gusakova')).toBe(false);
    const m = feeds.get('mariya-testova');
    expect(m?.photos.map((p) => p.href)).toEqual(['/places/ozero', '/routes/test-route']);
  });

  it('сетка: с каждого снимка — переход на место, alt — название места, первые снимки без ленивой загрузки', () => {
    const { container } = render(
      <AuthorPhotoGrid photos={[
        { url: '/a.jpg', alt: 'Озеро', href: '/places/ozero', license: 'CC BY 4.0' },
        { url: '/b.jpg', alt: 'Перевал', href: '/places/pereval', license: 'CC BY 4.0' },
        { url: '/c.jpg', alt: 'Бухта', href: '/places/buhta', license: 'CC BY 4.0' },
        { url: '/d.jpg', alt: 'Река', href: '/places/reka', license: 'CC BY 4.0' },
        { url: '/e.jpg', alt: 'Сопка', href: '/places/sopka', license: 'CC BY 4.0' },
      ]} />,
    );
    const links = [...container.querySelectorAll('a[data-testid="author-feed-item"]')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/places/ozero', '/places/pereval', '/places/buhta', '/places/reka', '/places/sopka']);
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('alt'))).toEqual(['Озеро', 'Перевал', 'Бухта', 'Река', 'Сопка']);
    expect(imgs[0].getAttribute('loading')).toBe('eager');
    expect(imgs[4].getAttribute('loading')).toBe('lazy');
  });
});

describe('карточка маршрута в «Похожих маршрутах»: снимок тура с подписью', () => {
  const base = {
    id: '3d5084c2-7d73-4511-b8c9-20251d89cc09', kind: 'route' as const, urlSlug: 'ganalskie-vostryaki-2',
    category: 'trekking', title: 'Ганальские востряки', description: 'Путь к Камчатским Альпам.',
    lat: null, lng: null, difficulty: 'medium', durationDays: null,
  };

  it('подпись — ссылка на страницу партнёра, ВНЕ ссылки на маршрут; alt — название места', () => {
    const { container } = render(<RoutePathCard route={{
      ...base, imageUrl: '/t.jpg', photoAlt: 'Ганальские востряки',
      photoCredit: { name: 'Андрей Запорожец', href: '/operators/andrey-zaporozhets', kind: 'partner' },
    }} />);
    const credit = container.querySelector('[data-testid="route-card-photo-credit"] a');
    expect(credit?.getAttribute('href')).toBe('/operators/andrey-zaporozhets');
    expect(credit?.textContent).toBe('Андрей Запорожец');
    expect(credit?.closest('a[href^="/routes/"]')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Ганальские востряки');
  });

  it('без снимка — ни картинки, ни подписи', () => {
    const { container } = render(<RoutePathCard route={{ ...base }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="route-card-photo-credit"]')).toBeNull();
  });

  it('первая карточка сетки — без ленивой загрузки (LCP), остальные — лениво', () => {
    const { container: a } = render(<RoutePathCard route={{ ...base, imageUrl: '/t.jpg' }} eager />);
    expect(a.querySelector('img')?.getAttribute('loading')).toBe('eager');
    cleanup();
    const { container: b } = render(<RoutePathCard route={{ ...base, imageUrl: '/t.jpg' }} />);
    expect(b.querySelector('img')?.getAttribute('loading')).toBe('lazy');
  });
});
