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
 * Как снять: статья переписана — удалить её slug из списка. Ни миграции, ни
 * правки базы не нужно; страница вернётся в индекс и в sitemap сама.
 * Оглавление `/articles` закрыто, пока в индексе нет ни одной статьи
 * (`articlesHubIndexable`): его тело — 27 выдержек из тех же текстов.
 */
export const ARTICLES_NOINDEX_SLUGS: ReadonlySet<string> = new Set([
  'buhty',
  'derevya-kamchatki',
  'dolina-gejzerov',
  'ekologicheskie-problemyi-kamchatki',
  'esso',
  'flora',
  'goroda-poselenija',
  'goryachie-istochniki',
  'istoriya',
  'kogda-luchshe-ehat-na-kamchatku',
  'morskoj-mir-kamchatki',
  'nizhnekamchatsk',
  'ozera',
  'ozero-azhabachje',
  'parki',
  'poselok-klyuchi',
  'rasteniya',
  'raznoe',
  'reka-kamchatka',
  'reki',
  'relef-kamchatki',
  'territoriya-kamchatki',
  'ug',
  'vodopady',
  'vulkany-kamchatki',
  'zhivotnye',
  'zima',
]);

/** Можно ли отдавать статью поисковику (и ставить её в sitemap). */
export function isArticleIndexable(slug: string): boolean {
  return !ARTICLES_NOINDEX_SLUGS.has(slug);
}

/**
 * Оглавление в индексе, только если в индексе есть хоть одна статья.
 * Пустой список (статей нет или не прочитались) — оглавление не закрываем:
 * «не смогли прочитать» не повод менять robots (§4.0).
 */
export function articlesHubIndexable(slugs: readonly string[]): boolean {
  if (slugs.length === 0) return true;
  return slugs.some(isArticleIndexable);
}

/** robots для закрытой страницы: не индексировать, по ссылкам ходить. */
export const NOINDEX_FOLLOW = { index: false, follow: true } as const;
