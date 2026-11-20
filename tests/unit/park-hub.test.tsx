/**
 * /park — список охраняемых территорий (SEO-аудит 20.11.2026: адрес был 404),
 * /park и /calendar в sitemap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

import ParksIndexPage from '@/app/park/page';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';

beforeEach(() => {
  query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const PARKS = [
  { slug: 'kronotsky', display_name: 'Кроноцкий заповедник', zone: 'eastern', description: 'Государственный биосферный заповедник на восточном побережье Камчатки.' },
  { slug: 'vachkazhets', display_name: 'Памятник природы «Вачкажец»', zone: null, description: null },
];

describe('/park', () => {
  it('список из справочника: имя, род, район, ссылка на карточку; без выдуманных фактов', async () => {
    query.mockResolvedValue({ rows: PARKS });
    const { container } = render(await ParksIndexPage());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Парки, заповедники и заказники Камчатки');
    const links = [...container.querySelectorAll('a[href^="/park/"]')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/park/kronotsky', '/park/vachkazhets']);
    expect(container.textContent).toContain('Заповедник · Восточная Камчатка');
    expect(container.textContent).toContain('Памятник природы');
    expect(container.textContent).toContain('Государственный биосферный заповедник на восточном побережье Камчатки.');
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.innerHTML);
    expect(ld['@type']).toBe('ItemList');
    expect(ld.itemListElement).toHaveLength(2);
    // numberOfItems — число элементов списка, не выдуманное (замечание Сыщика 21.11).
    expect(ld.numberOfItems).toBe(2);
  });

  it('база не ответила — так и сказано, разметки нет', async () => {
    query.mockRejectedValue(new Error('boom'));
    const { container } = render(await ParksIndexPage());
    expect(container.textContent).toContain('Не удалось загрузить список');
    expect(container.querySelector('script[type="application/ld+json"]')).toBeNull();
  });
});

describe('/park: ответ сразу, снимки, крошки (Сыщик 21.11)', () => {
  it('вводный абзац — счёт из справочника и ЮНЕСКО со ссылкой; BreadcrumbList; снимок с лицензией и подписью', async () => {
    query.mockResolvedValue({ rows: PARKS });
    const { container } = render(await ParksIndexPage());
    const intro = container.querySelector('[data-park-intro]')!;
    expect(intro.textContent).toContain('В справочнике Ведара 2 охраняемые территории Камчатки: 1 заповедник, 1 памятник природы.');
    expect(intro.querySelector('a[href="https://whc.unesco.org/en/list/765"]')).not.toBeNull();
    const lds = [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.innerHTML));
    const crumbs = lds.find((l) => l['@type'] === 'BreadcrumbList');
    expect(crumbs.itemListElement.map((i: { item: string }) => i.item)).toEqual(['https://vedarai.ru', 'https://vedarai.ru/park']);
    // Кроноцкий: снимок летописи с лицензией — картинка с alt и подписью автора.
    const kr = container.querySelector('a[href="/park/kronotsky"]')!;
    const img = kr.querySelector('img');
    expect(img?.getAttribute('alt')).toBeTruthy();
    expect(kr.querySelector('[data-photo-credit]')?.textContent).toMatch(/^Фото: .+, .+/);
  });
});

describe('sitemap: /park и /calendar', () => {
  it('обе страницы в карте; дата /park — самая поздняя правка парков', async () => {
    const NEW = new Date('2099-10-14T00:00:00Z');
    query.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM parks')) {
        return Promise.resolve({ rows: [{ slug: 'kronotsky', updated_at: new Date('2026-07-27T00:00:00Z') }, { slug: 'nalychevo', updated_at: NEW }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const { entries } = await collectSitemapEntriesWithStatus();
    const park = entries.find((e) => e.url === 'https://vedarai.ru/park');
    expect(park).toBeTruthy();
    expect(new Date(park!.lastModified!).toISOString()).toBe(NEW.toISOString());
    expect(entries.find((e) => e.url === 'https://vedarai.ru/calendar')).toBeTruthy();
  });
});

describe('/park: первый экран (Сыщик 21.11)', () => {
  it('вводный ответ — сразу под H1, до списка; первые два снимка без lazy, первый — fetchpriority high', async () => {
    const MANY = ['kronotsky', 'nalychevo', 'bystrinsky', 'yuzhno-kamchatsky'].map((slug) => ({ slug, display_name: slug, zone: null, description: null }));
    query.mockResolvedValue({ rows: MANY });
    const { container } = render(await ParksIndexPage());
    const main = container.querySelector('main')!;
    const h1 = main.querySelector('section h1')!;
    expect(h1.previousElementSibling, 'над H1 ничего').toBeNull();
    expect(h1.nextElementSibling?.hasAttribute('data-park-intro')).toBe(true);
    const imgs = [...main.querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    expect(imgs[0].getAttribute('fetchpriority')).toBe('high');
    imgs.forEach((img, i) => expect(img.getAttribute('loading'), `снимок ${i}`).toBe(i < 2 ? 'eager' : 'lazy'));
    imgs.slice(1).forEach((img) => expect(img.getAttribute('fetchpriority')).toBeNull());
  });

  it('без новых правок парков дата /park — ревизия вводного текста', async () => {
    const { PARK_HUB_TEXT_REVISION } = await import('@/lib/parks/park-hub');
    query.mockImplementation((sql: string) => String(sql).includes('FROM parks')
      ? Promise.resolve({ rows: [{ slug: 'kronotsky', updated_at: new Date('2026-07-27T00:00:00Z') }] })
      : Promise.resolve({ rows: [] }));
    const { entries } = await collectSitemapEntriesWithStatus();
    const park = entries.find((e) => e.url === 'https://vedarai.ru/park');
    expect(new Date(park!.lastModified!).toISOString().slice(0, 10)).toBe(PARK_HUB_TEXT_REVISION);
  });
});

