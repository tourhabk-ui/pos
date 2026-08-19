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
}

interface Row {
  id: string; slug: string; title: string; body: string | null;
  topic: string | null; source_url: string | null; source_name: string | null;
}

const toArticle = (r: Row): Article => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  body: r.body,
  topic: r.topic,
  sourceUrl: r.source_url,
  sourceName: r.source_name,
});

/**
 * Все видимые статьи.
 *
 * Ошибку не глушим: пустой список читался бы как «статей нет», а это другое
 * утверждение — ровно тот класс дефекта, за которым охотилась перепись.
 */
export async function listArticles(): Promise<Article[]> {
  const { rows } = await pool.query<Row>(
    `SELECT id::text, slug, title, body, topic, source_url, source_name
       FROM articles
      WHERE is_visible = TRUE
      ORDER BY topic NULLS LAST, title`,
  );
  return rows.map(toArticle);
}

/** Статья по адресу. null — статьи нет (страница отдаст 404). */
export async function getArticle(slug: string): Promise<Article | null> {
  const { rows } = await pool.query<Row>(
    `SELECT id::text, slug, title, body, topic, source_url, source_name
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
