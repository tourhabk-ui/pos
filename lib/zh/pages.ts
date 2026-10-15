/**
 * Китайский раздел сайта — один список страниц и один код языка (аудит 15.10,
 * CN-quick). Без базы: его читают sitemap (lib/seo/sitemap-entries), пинг
 * IndexNow (/api/cron/indexnow-plans) и layout раздела (meta Content-Language).
 *
 * Новая китайская страница (/zh/<…>) вносится сюда — и сразу попадает и в
 * sitemap, и в IndexNow; два списка разъехались бы при первой же странице.
 */

/** Язык раздела — тот же, что в hreflang и `lang` у <main>; next.config.js ставит его заголовком. */
export const ZH_CONTENT_LANGUAGE = 'zh-CN';

/** Индексируемые китайские страницы, пути от корня. */
export const ZH_PAGE_PATHS: readonly string[] = ['/zh'];

/** Абсолютные адреса китайских страниц — для sitemap и IndexNow. */
export function zhPageUrls(base: string): string[] {
  const root = base.replace(/\/+$/, '');
  return ZH_PAGE_PATHS.map((p) => `${root}${p}`);
}
