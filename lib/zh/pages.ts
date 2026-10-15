/**
 * Китайский раздел сайта — один список страниц и один код языка (аудит 15.10,
 * CN-quick). Без базы: его читают sitemap (lib/seo/sitemap-entries), пинг
 * IndexNow (/api/cron/indexnow-plans) и layout раздела (meta Content-Language).
 *
 * Новая китайская страница (/zh/<…>) вносится сюда — и сразу попадает и в
 * sitemap, и в IndexNow; два списка разъехались бы при первой же странице.
 *
 * С CN-pages (аудит 15.10) у раздела есть и страницы из базы — переводные
 * конспекты туров и мест (/zh/tours/*, /zh/places/*). Их список читает
 * lib/zh/content (loadZhDetailEntries: только с переводом), а собирает в один
 * перечень этот же zhPageUrls — у sitemap и IndexNow по-прежнему одна сборка.
 */

/** Язык раздела — тот же, что в hreflang и `lang` у <main>; next.config.js ставит его заголовком. */
export const ZH_CONTENT_LANGUAGE = 'zh-CN';

/** Индексируемые китайские страницы, пути от корня. */
export const ZH_PAGE_PATHS: readonly string[] = ['/zh'];

/**
 * Абсолютные адреса китайских страниц — для sitemap и IndexNow: статичные из
 * ZH_PAGE_PATHS и страницы из базы (`detailPaths`, пути от корня), без повторов.
 */
export function zhPageUrls(base: string, detailPaths: readonly string[] = []): string[] {
  const root = base.replace(/\/+$/, '');
  return [...new Set([...ZH_PAGE_PATHS, ...detailPaths].map((p) => `${root}${p}`))];
}

/** Адрес китайского конспекта тура: ЧПУ, у тура без него — число (как tourPath). */
export function zhTourPath(t: { id: string | number; slug?: string | null }): string {
  const slug = (t.slug ?? '').trim();
  return `/zh/tours/${slug || String(t.id)}`;
}

/** Адрес китайского конспекта места: ЧПУ, у места без него — id. */
export function zhPlacePath(p: { id: string; slug?: string | null }): string {
  const slug = (p.slug ?? '').trim();
  return `/zh/places/${slug || p.id}`;
}

/**
 * Канонический адрес русской карточки места — тот же, что она сама ставит в
 * canonical (app/places/[id]/page.tsx): ЧПУ, иначе ark_id. hreflang обязан
 * вести на канонический адрес: ссылка на places.id — второй адрес той же
 * карточки, и пара языков у поисковика не сходится.
 */
export function ruPlacePath(p: { id: string; slug?: string | null; ark_id?: string | null }): string {
  const slug = (p.slug ?? '').trim();
  return `/places/${slug || (p.ark_id ?? '').trim() || p.id}`;
}

/** Адрес из URL: битая %-последовательность — «такой страницы нет», а не 500. */
export function decodePathParam(raw: string | null | undefined): string | null {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    // URIError: адрес не раскодировать — страницы по нему нет (вызывающий отдаёт 404).
    return null;
  }
}
