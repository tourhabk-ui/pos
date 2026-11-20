/**
 * RSS-лента статей и посадочных (Сыщик 21.11, разрыв цитирования в ответах
 * ИИ): /rss.xml и /feed. Агрегаторы и поисковые агенты берут из ленты свежие
 * тексты быстрее, чем из обхода.
 *
 * В ленте только публичный текст: заголовок, описание сниппета, адрес и дата
 * правки. Ни авторов, ни контактов, ни полей пользователей — персональных
 * данных в ней нет и взяться им неоткуда: читаются только articles (видимые и
 * индексируемые) и реестр посадочных из кода.
 */
import { pool } from '@/lib/database';
import { isArticleIndexable } from '@/lib/articles/noindex';
import { LANDINGS } from '@/lib/landings/landings';

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  /** ISO-дата правки. */
  updated: string;
}

import { FEED_PATH, FEED_TITLE } from '@/lib/seo/rss-meta';

export { FEED_PATH, FEED_TITLE };
const FEED_LIMIT = 100;

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Управляющие символы XML 1.0 не допускает — лента не должна ломаться о мусор в тексте.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Свежие сверху, не больше FEED_LIMIT, без повторов адреса. */
export function sortFeedItems(items: readonly FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return [...items]
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .filter((i) => (seen.has(i.link) ? false : (seen.add(i.link), true)))
    .slice(0, FEED_LIMIT);
}

export function buildRss(base: string, items: readonly FeedItem[]): string {
  const root = base.replace(/\/$/, '');
  const list = sortFeedItems(items);
  const lastBuild = list[0]?.updated ?? new Date(0).toISOString();
  const body = list.map((i) => [
    '    <item>',
    `      <title>${xml(i.title)}</title>`,
    `      <link>${xml(i.link)}</link>`,
    `      <guid isPermaLink="true">${xml(i.link)}</guid>`,
    `      <pubDate>${new Date(i.updated).toUTCString()}</pubDate>`,
    ...(i.description ? [`      <description>${xml(i.description)}</description>`] : []),
    '    </item>',
  ].join('\n')).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xml(FEED_TITLE)}</title>`,
    `    <link>${xml(root)}/</link>`,
    `    <description>${xml('Новые и обновлённые статьи и путеводители о Камчатке: вулканы, парки, рыбалка, погода, как добраться.')}</description>`,
    '    <language>ru</language>',
    `    <lastBuildDate>${new Date(lastBuild).toUTCString()}</lastBuildDate>`,
    `    <atom:link href="${xml(root)}${FEED_PATH}" rel="self" type="application/rss+xml"/>`,
    body,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

/** Посадочные из кода: дата ревизии текста — `date`. */
export function landingFeedItems(base: string): FeedItem[] {
  const root = base.replace(/\/$/, '');
  return LANDINGS.map((l) => ({
    title: l.title,
    link: `${root}${l.path}`,
    description: l.description,
    updated: new Date(`${l.date}T00:00:00Z`).toISOString(),
  }));
}

/** Видимые индексируемые статьи: заголовок, описание сниппета, дата правки. */
export async function articleFeedItems(base: string): Promise<FeedItem[]> {
  const root = base.replace(/\/$/, '');
  const { rows } = await pool.query<{
    slug: string; title: string; meta_title: string | null; meta_description: string | null;
    source_url: string | null; updated_at: Date | string | null;
  }>(`
    SELECT slug, title, meta_title, meta_description, source_url, updated_at
      FROM articles
     WHERE is_visible = TRUE AND updated_at IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 200
  `);
  return rows
    .filter((r) => isArticleIndexable(r.slug, r.source_url))
    .map((r) => ({
      title: r.meta_title?.trim() || r.title,
      link: `${root}/articles/${r.slug}`,
      description: r.meta_description?.trim() || '',
      updated: new Date(r.updated_at as string | Date).toISOString(),
    }));
}

/** Лента целиком. Статьи не прочитались — лента из посадочных, а не 500. */
export async function feedXml(base: string): Promise<string> {
  let articles: FeedItem[] = [];
  try {
    articles = await articleFeedItems(base);
  } catch (e) {
    console.error('[rss] статьи не прочитаны:', e instanceof Error ? e.message : String(e));
  }
  return buildRss(base, [...landingFeedItems(base), ...articles]);
}
