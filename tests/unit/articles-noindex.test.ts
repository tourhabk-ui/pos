/**
 * Статьи-копии закрыты от индекса до переписывания (SEO-аудит 20.11.2026).
 *
 * Все 27 статей /articles дословно повторяют kamchatkaland.ru/note/<slug>.
 * До замены текстов: `noindex, follow` на странице, нет в sitemap; снять —
 * убрать slug из lib/articles/noindex. Оглавление закрыто, пока в индексе нет
 * ни одной статьи.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import {
  ARTICLES_NOINDEX_SLUGS, isArticleIndexable, articlesHubIndexable, NOINDEX_FOLLOW,
} from '@/lib/articles/noindex';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';
import { generateMetadata as articleMeta } from '@/app/articles/[slug]/page';
import { generateMetadata as hubMeta } from '@/app/articles/page';

const COPY = 'vulkany-kamchatki';
const OWN = 'nasha-statya';

beforeEach(() => {
  query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function articleRow(slug: string) {
  return { id: '1', slug, title: 'Вулканы Камчатки', body: 'Текст статьи о вулканах.', topic: null, source_url: null, source_name: null };
}

describe('список закрытых статей', () => {
  it('27 статей аудита, снятие — по одной', () => {
    expect(ARTICLES_NOINDEX_SLUGS.size).toBe(27);
    expect(isArticleIndexable(COPY)).toBe(false);
    expect(isArticleIndexable(OWN)).toBe(true);
  });

  it('оглавление: закрыто, пока все статьи в списке; пустой список robots не меняет', () => {
    expect(articlesHubIndexable([COPY, 'flora'])).toBe(false);
    expect(articlesHubIndexable([COPY, OWN])).toBe(true);
    expect(articlesHubIndexable([])).toBe(true);
  });
});

describe('страница статьи', () => {
  it('копия — noindex, follow; canonical остаётся', async () => {
    query.mockResolvedValue({ rows: [articleRow(COPY)] });
    const m = await articleMeta({ params: Promise.resolve({ slug: COPY }) });
    expect(m.robots).toEqual(NOINDEX_FOLLOW);
    expect(m.alternates?.canonical).toBe(`https://vedarai.ru/articles/${COPY}`);
  });

  it('статья не из списка — robots не задан (индексируется)', async () => {
    query.mockResolvedValue({ rows: [articleRow(OWN)] });
    const m = await articleMeta({ params: Promise.resolve({ slug: OWN }) });
    expect(m.robots).toBeUndefined();
  });
});

describe('оглавление /articles', () => {
  it('все статьи — копии: noindex, follow', async () => {
    query.mockResolvedValue({ rows: [{ slug: COPY, title: 'x', topic: null }] });
    expect((await hubMeta()).robots).toEqual(NOINDEX_FOLLOW);
  });
  it('есть своя статья — индексируется', async () => {
    query.mockResolvedValue({ rows: [{ slug: COPY, title: 'x', topic: null }, { slug: OWN, title: 'y', topic: null }] });
    expect((await hubMeta()).robots).toBeUndefined();
  });
  it('база не ответила — robots не трогаем', async () => {
    query.mockRejectedValue(new Error('boom'));
    expect((await hubMeta()).robots).toBeUndefined();
  });
});

describe('sitemap', () => {
  const at = new Date('2026-09-11T00:00:00Z');
  const scene = (slugs: string[] | 'fail') => query.mockImplementation((sql: string) => {
    if (String(sql).includes('FROM articles') && String(sql).includes('ORDER BY updated_at DESC')) {
      return slugs === 'fail' ? Promise.reject(new Error('boom')) : Promise.resolve({ rows: slugs.map((slug) => ({ slug, updated_at: at })) });
    }
    return Promise.resolve({ rows: [] });
  });
  const urls = async () => (await collectSitemapEntriesWithStatus()).entries.map((e) => e.url);

  it('копии не попадают в карту, своя статья попадает', async () => {
    scene([COPY, OWN]);
    const u = await urls();
    expect(u).not.toContain(`https://vedarai.ru/articles/${COPY}`);
    expect(u).toContain(`https://vedarai.ru/articles/${OWN}`);
    expect(u).toContain('https://vedarai.ru/articles');
  });

  it('все статьи закрыты — оглавления в карте нет', async () => {
    scene([COPY, 'flora']);
    const u = await urls();
    expect(u.some((x) => x.startsWith('https://vedarai.ru/articles'))).toBe(false);
  });

  it('статьи не прочитались — оглавление остаётся (не выдаём отказ за «пусто»)', async () => {
    scene('fail');
    expect(await urls()).toContain('https://vedarai.ru/articles');
  });
});
