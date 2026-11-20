/**
 * lib/articles/queries.ts
 *
 * Раздел статей: чтение.
 *
 * Откуда взялся раздел. Перепись 11.08 нашла в справочнике МАРШРУТОВ двадцать
 * шесть записей, которые источник опубликовал как заметки: «Флора Камчатки»,
 * «Растения Камчатки», «Экологические проблемы Камчатки». Туристу они
 * предлагались как маршрут — то есть как то, по чему можно пойти.
 *
 * Решение владельца: не удалять, а дать им свою полку — «так же как с видами
 * рыб». Текст про Камчатку не мусор; мусором его делает только неправильная
 * полка.
 *
 * ── Почему не в существующие разделы ───────────────────────────────────────
 *
 * Проверено, прежде чем заводить новый: `/blog` — дайджесты агентов из
 * `agent_knowledge` (новости отрасли, машинная лента), `/guides` —
 * аттестованные гиды, то есть люди. Ни то, ни другое не про флору, рельеф и
 * сезоны. Третий раздел с текстами завёлся бы зря, если бы подходил хоть
 * один; ни один не подошёл.
 */

import { pool } from '@/lib/db-pool';

export interface Article {
  id: string;
  slug: string;
  title: string;
  body: string | null;
  topic: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  /** Последняя правка записи (articles.updated_at); null — даты нет. */
  updatedAt: string | null;
  /**
   * Когда текст переписан своими словами (articles.rewritten_at, миграция
   * 1471); null — текст прежний. Признак «переписана»: по нему страница
   * рисует markdown и ставит разметку Article/FAQPage.
   */
  rewrittenAt: string | null;
  /** Заголовок и описание сниппета из переписанного текста; null — нет. */
  metaTitle: string | null;
  metaDescription: string | null;
}

interface Row {
  id: string; slug: string; title: string; body: string | null;
  topic: string | null; source_url: string | null; source_name: string | null;
  updated_at?: string | Date | null;
  rewritten_at?: string | Date | null;
  meta_title?: string | null;
  meta_description?: string | null;
}

const iso = (v: string | Date | null | undefined): string | null =>
  v == null ? null : new Date(v).toISOString();

const toArticle = (r: Row): Article => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  body: r.body,
  topic: r.topic,
  sourceUrl: r.source_url,
  sourceName: r.source_name,
  updatedAt: iso(r.updated_at),
  rewrittenAt: iso(r.rewritten_at),
  metaTitle: r.meta_title?.trim() || null,
  metaDescription: r.meta_description?.trim() || null,
});

const ARTICLE_COLUMNS = `id::text, slug, title, body, topic, source_url, source_name, updated_at,
            rewritten_at, meta_title, meta_description`;

/**
 * Все видимые статьи.
 *
 * Ошибку не глушим: пустой список читался бы как «статей нет», а это другое
 * утверждение — ровно тот класс дефекта, за которым охотилась перепись.
 */
export async function listArticles(): Promise<Article[]> {
  const { rows } = await pool.query<Row>(
    `SELECT ${ARTICLE_COLUMNS}
       FROM articles
      WHERE is_visible = TRUE
      ORDER BY topic NULLS LAST, title`,
  );
  return rows.map(toArticle);
}

export interface ArticleLink {
  slug: string;
  title: string;
  topic: string | null;
  /** Адрес источника: копия kamchatkaland.ru — вне индекса (lib/articles/noindex). */
  source_url?: string | null;
}

/**
 * Адреса видимых статей в порядке оглавления — для блока «Читайте дальше».
 * Без текста: двадцать семь тел статей ради двадцати семи заголовков не нужны.
 */
export async function listArticleLinks(): Promise<ArticleLink[]> {
  const { rows } = await pool.query<ArticleLink>(
    `SELECT slug, title, topic, source_url
       FROM articles
      WHERE is_visible = TRUE
      ORDER BY topic NULLS LAST, title`,
  );
  return rows;
}

/** Статья по адресу. null — статьи нет (страница отдаст 404). */
export async function getArticle(slug: string): Promise<Article | null> {
  const { rows } = await pool.query<Row>(
    `SELECT ${ARTICLE_COLUMNS}
       FROM articles
      WHERE slug = $1 AND is_visible = TRUE
      LIMIT 1`,
    [slug],
  );
  return rows[0] ? toArticle(rows[0]) : null;
}

/**
 * Темы с числом статей — оглавление раздела.
 *
 * Статьи без темы собираются под честным «Разное», а не приписываются к
 * первой попавшейся: выдуманная рубрика хуже отсутствующей.
 */
export function groupByTopic(articles: Article[]): Array<{ topic: string; items: Article[] }> {
  const map = new Map<string, Article[]>();
  for (const a of articles) {
    const key = a.topic?.trim() || 'Разное';
    const list = map.get(key);
    if (list) list.push(a);
    else map.set(key, [a]);
  }
  return [...map.entries()]
    .map(([topic, items]) => ({ topic, items }))
    .sort((x, y) => (x.topic === 'Разное' ? 1 : y.topic === 'Разное' ? -1 : x.topic.localeCompare(y.topic, 'ru')));
}
