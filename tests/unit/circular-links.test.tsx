/**
 * Перелинковка по кругу (14.10) — вызовом и рендером страниц (правило 13.10).
 *
 * Перепись sitemap, прогон 10: 52 страницы с единственной входящей ссылкой — с
 * хаба своего раздела. Статьям (27) не хватало блока «читайте дальше» вовсе,
 * планы (9) ссылались только на ПЕРВЫЕ шесть, подборкам (6) не на кого было
 * ссылаться. Следующие по кругу дают каждой странице ровно n входящих — это
 * свойство и проверяется: счётом ссылок по всем страницам раздела.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';

const listArticleLinksMock = vi.fn();
const getArticleMock = vi.fn();
const loadPublicCollectionsMock = vi.fn();
vi.mock('@/lib/articles/queries', () => ({
  getArticle: (...a: unknown[]) => getArticleMock(...a),
  listArticleLinks: (...a: unknown[]) => listArticleLinksMock(...a),
}));
vi.mock('@/lib/collections/list', () => ({
  loadPublicCollections: (...a: unknown[]) => loadPublicCollectionsMock(...a),
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NOT_FOUND'); },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));

import { circularNext } from '@/lib/seo/circular-links';
import { OtherPlans, OTHER_PLANS } from '@/components/plans/OtherPlans';
import { PLAN_PRESETS } from '@/lib/plans/presets';
import ArticlePage from '@/app/articles/[slug]/page';
import CollectionDetailPage from '@/app/collections/[slug]/page';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const letters = 'abcdefg'.split('');
const same = (x: string) => (y: string) => x === y;

describe('circularNext: следующие по кругу', () => {
  it('после текущей, с переходом через конец, без самой текущей', () => {
    expect(circularNext(letters, same('b'), 3)).toEqual(['c', 'd', 'e']);
    expect(circularNext(letters, same('f'), 3)).toEqual(['g', 'a', 'b']);
  });

  it('просят больше, чем есть соседей, — все остальные, без повторов и без себя', () => {
    expect(circularNext(['a', 'b', 'c'], same('b'), 6)).toEqual(['c', 'a']);
    expect(circularNext(['a'], same('a'), 4)).toEqual([]);
  });

  it('текущей в списке нет — первые n, блок не пропадает', () => {
    expect(circularNext(letters, same('z'), 2)).toEqual(['a', 'b']);
  });

  it('пустой список и n = 0 — пусто', () => {
    expect(circularNext([], same('a'), 3)).toEqual([]);
    expect(circularNext(letters, same('a'), 0)).toEqual([]);
  });

  it('каждая страница получает ровно n входящих — поровну, без любимчиков и сирот', () => {
    const inbound = new Map<string, number>();
    for (const page of letters) {
      for (const to of circularNext(letters, same(page), 3)) inbound.set(to, (inbound.get(to) ?? 0) + 1);
    }
    expect([...inbound.values()]).toEqual(letters.map(() => 3));
  });
});

describe('«Другие готовые планы»: соседи по кругу, а не первые шесть', () => {
  const linksOf = (slug: string) => {
    const { container, unmount } = render(<OtherPlans current={slug} />);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    unmount();
    return hrefs;
  };

  it('на каждый план ведут ровно шесть других — и на последние тоже', () => {
    const inbound = new Map<string, number>(PLAN_PRESETS.map((p) => [`/plans/${p.slug}`, 0]));
    for (const p of PLAN_PRESETS) {
      const hrefs = linksOf(p.slug);
      expect(hrefs, p.slug).toHaveLength(OTHER_PLANS);
      expect(hrefs, p.slug).not.toContain(`/plans/${p.slug}`);
      for (const h of hrefs) inbound.set(h, (inbound.get(h) ?? 0) + 1);
    }
    expect([...inbound.entries()].filter(([, n]) => n !== OTHER_PLANS)).toEqual([]);
    expect(PLAN_PRESETS.length).toBeGreaterThan(OTHER_PLANS + 1);
  });

  it('заголовок блока и имена планов — как видит человек', () => {
    render(<OtherPlans current={PLAN_PRESETS[0].slug} />);
    const nav = screen.getByRole('region', { name: 'Другие готовые планы' });
    expect(within(nav).getByText(PLAN_PRESETS[1].title).closest('a')?.getAttribute('href'))
      .toBe(`/plans/${PLAN_PRESETS[1].slug}`);
  });
});

describe('статья: «Читайте дальше»', () => {
  const LINKS = Array.from({ length: 6 }, (_, i) => ({ slug: `s${i}`, title: `Статья ${i}`, topic: i < 3 ? 'Природа' : 'История' }));
  const article = (slug: string) => ({ id: '1', slug, title: `Статья ${slug.slice(1)}`, body: 'Абзац.\n\nЕщё абзац.', topic: 'Природа', sourceUrl: null, sourceName: null });

  beforeEach(() => {
    getArticleMock.mockReset();
    listArticleLinksMock.mockReset();
    listArticleLinksMock.mockResolvedValue(LINKS);
  });

  async function renderArticle(slug: string) {
    getArticleMock.mockResolvedValue(article(slug));
    render(await ArticlePage({ params: Promise.resolve({ slug }) }));
  }

  it('четыре следующие по оглавлению, с темой, без самой статьи', async () => {
    await renderArticle('s1');
    const nav = screen.getByRole('navigation', { name: 'Читайте дальше' });
    const hrefs = within(nav).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/articles/s2', '/articles/s3', '/articles/s4', '/articles/s5']);
    expect(within(nav).getAllByText('История')).toHaveLength(3);
  });

  it('у последней статьи — переход через начало оглавления', async () => {
    await renderArticle('s5');
    const nav = screen.getByRole('navigation', { name: 'Читайте дальше' });
    expect(within(nav).getAllByRole('link').map((a) => a.getAttribute('href')))
      .toEqual(['/articles/s0', '/articles/s1', '/articles/s2', '/articles/s3']);
  });

  it('соседи не прочитались — статья на месте, блока нет, причина в логе', async () => {
    listArticleLinksMock.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderArticle('s1');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Статья 1');
    expect(screen.queryByRole('navigation', { name: 'Читайте дальше' })).toBeNull();
    expect(spy.mock.calls.some((c) => c.join(' ').includes('sqlstate=57014'))).toBe(true);
  });
});

describe('подборка: «Другие подборки»', () => {
  const ALL = ['vulkany', 'ozera', 'vodopady', 'istochniki', 'buhty', 'medvedi'].map((slug) => ({ slug, title: `Подборка ${slug}` }));
  const collection = (slug: string) => ({ id: '1', slug, title: `Подборка ${slug}`, description: null, cover_image: null, tags: [], view_count: 3, places: [], routes: [] });

  beforeEach(() => {
    loadPublicCollectionsMock.mockReset();
    loadPublicCollectionsMock.mockResolvedValue(ALL);
  });

  function serve(status: number, body?: unknown) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body ?? {}), { status }));
  }

  it('три следующие в порядке хаба, с переходом через конец', async () => {
    serve(200, { collection: collection('buhty') });
    render(await CollectionDetailPage({ params: Promise.resolve({ slug: 'buhty' }) }));
    const nav = screen.getByRole('navigation', { name: 'Другие подборки' });
    expect(within(nav).getAllByRole('link').map((a) => a.getAttribute('href')))
      .toEqual(['/collections/medvedi', '/collections/vulkany', '/collections/ozera']);
  });

  it('список не прочитался — подборка на месте, блока нет, причина в логе', async () => {
    serve(200, { collection: collection('ozera') });
    loadPublicCollectionsMock.mockRejectedValue(Object.assign(new Error('boom'), { code: '08006' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(await CollectionDetailPage({ params: Promise.resolve({ slug: 'ozera' }) }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Подборка ozera');
    expect(screen.queryByRole('navigation', { name: 'Другие подборки' })).toBeNull();
    expect(spy.mock.calls.some((c) => c.join(' ').includes('sqlstate=08006'))).toBe(true);
  });

  it('сбой API подборки называется в логе, а не молча становится «не найдено»', async () => {
    serve(500);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(CollectionDetailPage({ params: Promise.resolve({ slug: 'ozera' }) })).rejects.toThrow('NOT_FOUND');
    expect(spy.mock.calls.some((c) => c.join(' ').includes('HTTP 500'))).toBe(true);
  });

  it('404 API — просто «не найдено», без строки сбоя', async () => {
    serve(404);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(CollectionDetailPage({ params: Promise.resolve({ slug: 'net-takoj' }) })).rejects.toThrow('NOT_FOUND');
    expect(spy).not.toHaveBeenCalled();
  });
});
