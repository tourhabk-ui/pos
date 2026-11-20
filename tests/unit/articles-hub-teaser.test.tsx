/**
 * Хаб /articles (замечание Сыщика 21.11): у статей из noindex-списка — только
 * название и ссылка, без выдержки чужого текста; у прочих анонс остаётся.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ARTICLES_NOINDEX_SLUGS } from '@/lib/articles/noindex';

const copied = [...ARTICLES_NOINDEX_SLUGS][0];

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));
vi.mock('@/lib/articles/queries', async (orig) => {
  const real = await orig<typeof import('@/lib/articles/queries')>();
  return {
    ...real,
    listArticles: vi.fn(async () => [
      { id: '1', slug: copied, title: 'Чужая статья', body: 'ЧУЖОЙ ТЕКСТ первого абзаца.', topic: 'Природа', sourceUrl: null, sourceName: null },
      { id: '2', slug: 'nasha-statya', title: 'Наша статья', body: 'НАШ ТЕКСТ первого абзаца.', topic: 'Природа', sourceUrl: null, sourceName: null },
    ]),
  };
});

import ArticlesIndexPage from '@/app/articles/page';

describe('хаб /articles: анонсы', () => {
  it('статья из noindex-списка — название и ссылка без выдержки', async () => {
    const html = renderToStaticMarkup(await ArticlesIndexPage());
    expect(html).toContain(`href="/articles/${copied}"`);
    expect(html).toContain('Чужая статья');
    expect(html).not.toContain('ЧУЖОЙ ТЕКСТ');
  });

  it('статья вне списка — анонс остаётся', async () => {
    const html = renderToStaticMarkup(await ArticlesIndexPage());
    expect(html).toContain('href="/articles/nasha-statya"');
    expect(html).toContain('НАШ ТЕКСТ первого абзаца.');
  });
});
