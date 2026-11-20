/**
 * Переписанные статьи (миграция 1471): тексты своими словами вместо копий
 * kamchatkaland.ru. Судит рендер: что видит человек, что получает поисковик.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseArticleMarkdown, faqFromBlocks, shortAnswer, safeHref, parseInline } from '@/lib/articles/markdown';
import { ArticleMarkdown } from '@/components/articles/ArticleMarkdown';
import { ARTICLES_NOINDEX_SLUGS, isArticleIndexable, isCopiedSource } from '@/lib/articles/noindex';

const article = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));
vi.mock('@/lib/articles/queries', async (orig) => ({
  ...(await orig<typeof import('@/lib/articles/queries')>()),
  getArticle: vi.fn(async () => article.current),
  listArticleLinks: vi.fn(async () => []),
}));

import ArticlePage, { generateMetadata } from '@/app/articles/[slug]/page';

const MIGRATION = readFileSync(join(process.cwd(), 'migrations/1471_articles_rewritten_texts.sql'), 'utf8');
const updates = [...MIGRATION.matchAll(/title\s+= \$md\$(.*?)\$md\$,[\s\S]*?meta_title\s+= \$md\$(.*?)\$md\$,[\s\S]*?meta_description\s+= \$md\$(.*?)\$md\$,[\s\S]*?body\s+= \$md\$([\s\S]*?)\$md\$,[\s\S]*?WHERE slug = '([a-z0-9-]+)';/g)]
  .map((m) => ({ title: m[1], metaTitle: m[2], metaDescription: m[3], body: m[4], slug: m[5] }));

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');

describe('миграция 1471', () => {
  it('27 статей, у каждой заголовок, сниппет ≤ 160 и текст', () => {
    expect(updates).toHaveLength(27);
    for (const u of updates) {
      expect(u.title.length).toBeGreaterThan(10);
      expect(u.metaDescription.length).toBeLessThanOrEqual(160);
      expect(u.body.length).toBeGreaterThan(3000);
    }
  });

  it('в тексте нет «Обновлено: …» — видимая дата только из updated_at', () => {
    for (const u of updates) expect(u.body).not.toMatch(/Обновлено/);
  });

  it('прежний текст и источник уходят в архив, а не удаляются', () => {
    expect(MIGRATION).toMatch(/body_withdrawn\s+= COALESCE\(body_withdrawn, body\)/);
    expect(MIGRATION).toMatch(/source_url_withdrawn\s+= COALESCE\(source_url_withdrawn, source_url\)/);
  });
});

describe('рендер всех 27 текстов', () => {
  for (const u of updates) {
    it(`${u.slug}: без сырой разметки, сноски ведут в источники, FAQ разобран`, () => {
      const blocks = parseArticleMarkdown(u.body);
      const html = renderToStaticMarkup(<ArticleMarkdown blocks={blocks} />);
      const text = textOf(html);
      expect(text).not.toMatch(/\*\*|\]\(|^\s*\|/m);
      expect(html).not.toMatch(/<script|javascript:/i);
      const refs = new Set([...html.matchAll(/href="#source-(\d+)"/g)].map((m) => m[1]));
      for (const n of refs) expect(html).toContain(`id="source-${n}"`);
      expect(faqFromBlocks(blocks).length).toBeGreaterThanOrEqual(5);
      expect(shortAnswer(blocks)?.length ?? 0).toBeGreaterThan(50);
      expect(blocks.filter((b) => b.t === 'h2').length).toBeGreaterThanOrEqual(8);
    });
  }
});

describe('разметка: безопасность ссылок', () => {
  it('свой сайт — относительный путь; чужой http(s) — как есть; прочее — текст', () => {
    expect(safeHref('https://vedarai.ru/park/bystrinskiy')).toBe('/park/bystrinskiy');
    expect(safeHref('https://ru.wikipedia.org/wiki/Эссо')).toBe('https://ru.wikipedia.org/wiki/Эссо');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: 'x' }, { t: 'text', v: ')' }]);
    expect(renderToStaticMarkup(<ArticleMarkdown blocks={parseArticleMarkdown('<img src=x onerror=1>')} />)).toContain('&lt;img');
  });
});

describe('индекс', () => {
  it('все 27 сняты со списка; копия по источнику закрыта и без списка', () => {
    expect(ARTICLES_NOINDEX_SLUGS.size).toBe(0);
    for (const u of updates) expect(isArticleIndexable(u.slug, null)).toBe(true);
    expect(isCopiedSource('https://kamchatkaland.ru/note/esso')).toBe(true);
    expect(isArticleIndexable('esso', 'https://kamchatkaland.ru/note/esso')).toBe(false);
  });
});

describe('страница переписанной статьи', () => {
  const esso = updates.find((u) => u.slug === 'esso')!;
  const row = (over: Record<string, unknown> = {}) => ({
    id: '1', slug: 'esso', title: esso.title, body: esso.body, topic: 'Край', sourceUrl: null, sourceName: null,
    updatedAt: '2026-11-21T01:00:00.000Z', rewrittenAt: '2026-11-21T01:00:00.000Z',
    metaTitle: esso.metaTitle, metaDescription: esso.metaDescription, ...over,
  });
  beforeEach(() => { article.current = row(); });

  it('Article + FAQPage, даты из записи; видимая дата; индексируется', async () => {
    const html = renderToStaticMarkup(await ArticlePage({ params: Promise.resolve({ slug: 'esso' }) }));
    const ld = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const graph = ld.flatMap((n) => n['@graph'] ?? [n]);
    const art = graph.find((n) => n['@type'] === 'Article');
    const faq = graph.find((n) => n['@type'] === 'FAQPage');
    expect(art.headline).toBe(esso.title);
    expect(art.dateModified).toBe('2026-11-21T01:00:00.000Z');
    expect(art.datePublished).toBe('2026-11-21T01:00:00.000Z');
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(5);
    expect(faq.mainEntity[0].acceptedAnswer.text).not.toMatch(/\[\d+\]|\*\*/);
    expect(html).toContain('Последняя правка записи');
    expect(html).not.toContain('Источник:');
    const meta = await generateMetadata({ params: Promise.resolve({ slug: 'esso' }) });
    expect(meta.robots).toBeUndefined();
    expect(meta.description).toBe(esso.metaDescription);
  });

  it('нет updated_at — нет ни видимой даты, ни dateModified', async () => {
    article.current = row({ updatedAt: null });
    const html = renderToStaticMarkup(await ArticlePage({ params: Promise.resolve({ slug: 'esso' }) }));
    expect(html).not.toContain('Последняя правка записи');
    expect(html).not.toContain('dateModified');
  });

  it('без признака «переписана» — ни Article, ни FAQPage; копия kamchatkaland — noindex', async () => {
    article.current = row({ rewrittenAt: null, metaTitle: null, metaDescription: null, body: 'Старый текст.', sourceUrl: 'https://kamchatkaland.ru/note/esso' });
    const html = renderToStaticMarkup(await ArticlePage({ params: Promise.resolve({ slug: 'esso' }) }));
    expect(html).not.toContain('"Article"');
    expect(html).not.toContain('FAQPage');
    const meta = await generateMetadata({ params: Promise.resolve({ slug: 'esso' }) });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });
});
