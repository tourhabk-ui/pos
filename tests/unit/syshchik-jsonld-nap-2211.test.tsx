/**
 * Правки Сыщика 22.11: ItemList каталога и /medvedi-kamchatki,
 * видимая строка редакции на посадочных, NAP в подвале и Organization.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { buildToursItemListJsonLd } from '@/lib/tours/marketplace-page';
import type { MarketplaceTourRow } from '@/lib/search';
import { landingItemListJsonLd } from '@/components/landings/LandingPage';
import { LandingContent, landingJsonLd } from '@/components/landings/LandingContent';
import { landingBySlug, LANDINGS } from '@/lib/landings/landings';
import { ORGANIZATION_PROFILES, ORGANIZATION_SAME_AS } from '@/lib/seo/organization-profiles';
import { Footer } from '@/components/layout/Footer';
import { formatRecordDate, recordDateIso } from '@/lib/seo/record-modified';

const SITE = 'https://vedarai.ru';

describe('ItemList /catalog', () => {
  it('у каждого ListItem есть position, name и абсолютный url', () => {
    const tours = [
      { id: '1', slug: 'a', title: 'Тур А', description: 'А', operator_name: 'Оп', base_price: '1000' },
      { id: '2', slug: 'b', title: 'Тур Б', description: 'Б', operator_name: 'Оп', base_price: '2000' },
    ] as unknown as MarketplaceTourRow[];
    const ld = buildToursItemListJsonLd(tours, SITE, '/catalog') as {
      '@type': string;
      itemListElement: Array<{ position: number; name: string; url: string }>;
    };
    expect(ld['@type']).toBe('ItemList');
    expect(ld.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Тур А', url: `${SITE}/catalog/tours/a`, item: expect.any(Object) },
      { '@type': 'ListItem', position: 2, name: 'Тур Б', url: `${SITE}/catalog/tours/b`, item: expect.any(Object) },
    ]);
  });
});

describe('ItemList /medvedi-kamchatki', () => {
  it('JSON-LD повторяет видимый список туров: то же число, name и абсолютный url', () => {
    const tours = [
      { id: '79', slug: 'zaporozhets-kurilskoe-ozero-3-dnya', title: 'Курильское озеро на внедорожнике, 3 дня', operator_name: 'А', operator_slug: 'a', operator_public: true, cover: null },
      { id: '81', slug: 'zaporozhets-kurilskoe-ozero-4-dnya', title: 'Курильское озеро на внедорожнике, 4 дня', operator_name: 'А', operator_slug: 'a', operator_public: true, cover: null },
    ];
    const landing = landingBySlug('medvedi-kamchatki');
    const ld = landingItemListJsonLd(landing, tours) as {
      '@type': string;
      numberOfItems: number;
      itemListElement: Array<{ position: number; name: string; url: string }>;
    };
    expect(ld['@type']).toBe('ItemList');
    expect(ld.numberOfItems).toBe(tours.length);
    expect(ld.itemListElement).toHaveLength(tours.length);
    const { container } = render(<LandingContent landing={landing} tours={tours as never} showH1={false} />);
    const visible = [...container.querySelectorAll('[data-landing-tour]')];
    expect(visible).toHaveLength(tours.length);
    ld.itemListElement.forEach((el, i) => {
      expect(el.position).toBe(i + 1);
      expect(el.name).toBe(tours[i].title);
      expect(el.url).toBe(`${SITE}/catalog/tours/${tours[i].slug}`);
      expect(visible[i].textContent).toContain(tours[i].title);
    });
  });
});

describe('Редакция Vedar на посадочных партий 4 и примерах Сыщика', () => {
  const slugs = [
    'chto-posmotret-na-kamchatke',
    'kak-dobratsya-na-kamchatku',
    'nalychevo-kak-dobratsya',
    'serfing-na-kamchatke',
  ] as const;

  it.each(slugs)('%s: видимая строка в SSR и Article.author/dateModified', (slug) => {
    const landing = landingBySlug(slug);
    const { container } = render(<LandingContent landing={landing} tours={[]} />);
    const line = container.querySelector('[data-record-modified]');
    expect(line?.textContent).toBe(`Редакция Vedar · факты проверены ${formatRecordDate(landing.date)}`);
    expect(line?.querySelector('time')?.getAttribute('dateTime')).toBe(recordDateIso(landing.date));
    const ld = landingJsonLd(landing) as { '@graph': Array<Record<string, unknown>> };
    const article = ld['@graph'].find((n) => n['@type'] === 'Article')!;
    const author = article.author as { '@type': string; name: string };
    expect(author['@type']).toBe('Organization');
    expect(author.name).toMatch(/Vedar|Ведар/);
    expect(article.dateModified).toBe(recordDateIso(landing.date));
  });

  it('у всех посадочных есть дата ревизии текста', () => {
    for (const l of LANDINGS) {
      expect(l.date, l.slug).toMatch(/^2026-11-2[01]$/);
    }
  });
});

describe('NAP: подвал и Organization sameAs', () => {
  it('в подвале поддержка @kuzmichai_bot, канал Telegram и канал MAX _biz', () => {
    const { container } = render(<Footer />);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(ORGANIZATION_PROFILES.telegramSupport);
    expect(hrefs).toContain(ORGANIZATION_PROFILES.telegramChannel);
    expect(hrefs).toContain(ORGANIZATION_PROFILES.maxChannel);
    expect(container.textContent).toContain('@kuzmichai_bot');
    expect(container.innerHTML).not.toMatch(/kamchatourhub/);
    expect(hrefs.some((h) => h?.includes('kamchatourhub'))).toBe(false);
  });

  it('sameAs содержит канал Telegram, канал MAX _biz и бота поддержки; Дзен не выдуман', () => {
    expect(ORGANIZATION_SAME_AS).toContain(ORGANIZATION_PROFILES.telegramChannel);
    expect(ORGANIZATION_SAME_AS).toContain(ORGANIZATION_PROFILES.maxChannel);
    expect(ORGANIZATION_SAME_AS).toContain(ORGANIZATION_PROFILES.telegramSupport);
    expect(ORGANIZATION_SAME_AS.some((u) => /dzen\.ru|zen\.yandex/.test(u))).toBe(false);
    const layout = readFileSync('app/layout.tsx', 'utf8');
    expect(layout).toContain('ORGANIZATION_SAME_AS');
    expect(layout).toContain('ORGANIZATION_PROFILES.telegramSupport');
  });
});
