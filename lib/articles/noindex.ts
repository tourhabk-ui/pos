/**
 * Статьи, закрытые от индекса до переписывания (SEO-аудит 20.11.2026).
 *
 * Все 27 видимых статей раздела `/articles` пришли импортом с kamchatkaland.ru
 * (`lib/agents/kamchatkaland-importer.ts`) и дословно повторяют страницы
 * `kamchatkaland.ru/note/<slug>`. Выборочная сверка 20.11 (4 статьи:
 * vulkany-kamchatki, reka-kamchatka, nizhnekamchatsk, flora) — 90–97%
 * предложений длиннее 80 знаков совпадают с источником слово в слово.
 * Копия конкурента в индексе — риск фильтра Яндекса для всего сайта.
 *
 * Решение владельца (20.11): тексты переписываются своими словами, а до
 * замены страница отдаёт `noindex, follow` и не стоит в sitemap. Ссылки со
 * страницы по-прежнему проходят (`follow`), людям статья доступна как была.
 *
 * Как снять: статья переписана — удалить её slug из списка.
 *
 * 21.11: все 27 переписаны своими словами (миграция 1471, статус «готово к
 * публикации» у каждой в index.md рабочей папки Сыщика) — список пуст.
 * Механизм остаётся: новая копия чужого текста закрывается строкой здесь.
 *
 * Вторая защита — по данным, а не по списку: статья, у которой источником
 * записан kamchatkaland.ru (`source_url`), — копия, и она вне индекса, даже
 * если slug в список не попал. Миграция 1471 переносит адрес источника в
 * архив (`source_url_withdrawn`) вместе с заменой текста; пока замена не
 * прошла (миграция не применилась), копия остаётся закрытой сама.
 * Оглавление `/articles` закрыто, пока в индексе нет ни одной статьи
 * (`articlesHubIndexable`): его тело — 27 выдержек из тех же текстов.
 */
export const ARTICLES_NOINDEX_SLUGS: ReadonlySet<string> = new Set<string>([]);

/** Источник — сайт, чьи тексты лежали у нас копией (импорт kamchatkaland, аудит 20.11). */
const COPIED_SOURCE_RE = /^https?:\/\/(?:www\.)?kamchatkaland\.ru(?:\/|$)/i;

/** Текст статьи — копия чужого сайта (по записанному источнику). */
export function isCopiedSource(sourceUrl: string | null | undefined): boolean {
  return !!sourceUrl && COPIED_SOURCE_RE.test(sourceUrl.trim());
}

/**
 * Можно ли отдавать статью поисковику (и ставить её в sitemap): slug не в
 * списке и источник — не сайт, откуда текст скопирован.
 */
export function isArticleIndexable(slug: string, sourceUrl?: string | null): boolean {
  return !ARTICLES_NOINDEX_SLUGS.has(slug) && !isCopiedSource(sourceUrl);
}

/**
 * Оглавление в индексе, только если в индексе есть хоть одна статья.
 * Пустой список (статей нет или не прочитались) — оглавление не закрываем:
 * «не смогли прочитать» не повод менять robots (§4.0).
 */
export function articlesHubIndexable(
  items: ReadonlyArray<string | { slug: string; source_url?: string | null }>,
): boolean {
  if (items.length === 0) return true;
  return items.some((a) => (typeof a === 'string' ? isArticleIndexable(a) : isArticleIndexable(a.slug, a.source_url)));
}

/** robots для закрытой страницы: не индексировать, по ссылкам ходить. */
export const NOINDEX_FOLLOW = { index: false, follow: true } as const;
