/**
 * Статья (аудит 20.11, пункт 6): дата правки — из articles.updated_at, видна в
 * HTML и стоит в dateModified; поля нет — ни строки, ни узла. Проверка рендером.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const article = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/articles/queries', () => ({
  getArticle: vi.fn(async () => article.current),
  listArticleLinks: vi.fn(async () => []),
}));

import ArticlePage from '@/app/articles/[slug]/page';

const base = {
  id: '1', slug: 'ozero', title: 'Озеро', body: 'Текст.', topic: null,
  sourceUrl: null, sourceName: null,
};

async function html() {
  const el = await ArticlePage({ params: Promise.resolve({ slug: 'ozero' }) });
  return renderToStaticMarkup(el);
}

describe('страница статьи: дата правки записи', () => {
  beforeEach(() => { article.current = null; });

  it('updated_at есть — видимая строка и WebPage.dateModified', async () => {
    article.current = { ...base, updatedAt: '2026-10-14T03:00:00.000Z' };
    const out = await html();
    expect(out).toContain('Последняя правка записи');
    expect(out).toContain('14 октября 2026');
    const ld = [...out.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]));
    const page = ld.find((n) => n['@type'] === 'WebPage');
    expect(page?.dateModified).toBe('2026-10-14T03:00:00.000Z');
    expect(page?.url).toBe('https://vedarai.ru/articles/ozero');
  });

  it('поля нет — ни строки, ни dateModified', async () => {
    article.current = { ...base, updatedAt: null };
    const out = await html();
    expect(out).not.toContain('Последняя правка записи');
    expect(out).not.toContain('dateModified');
  });
});
