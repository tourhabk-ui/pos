/**
 * Китайский раздел сайта — один список страниц и один код языка (аудит 15.10,
 * CN-quick). Без базы: его читают sitemap (lib/seo/sitemap-entries), пинг
 * IndexNow (/api/cron/indexnow-plans) и layout раздела (meta Content-Language).
 *
 * Новая китайская страница (/zh/<…>) вносится сюда — и сразу попадает и в
 * sitemap, и в IndexNow; два списка разъехались бы при первой же странице.
 *
 * С CN-pages (аудит 15.10) у раздела есть и страницы из базы (/zh/tours/*,
 * /zh/places/*). Туры в sitemap входят все живые: страница — китайские факты
 * из базы (lib/zh/content). Места — только со свежим переводом описания.
 * Собирает перечень этот же zhPageUrls — у sitemap и IndexNow одна сборка.
 *
 * Ревизия статичных страниц — дата правки китайского текста (25.10), а не
 * день первой /zh: иначе lastmod врёт, что страницы не менялись.
 */
export const ZH_STATIC_REVISION = '2026-10-25';

/** Китайский каталог — языковая пара русской /catalog. */
export const ZH_CATALOG_PATH = '/zh/catalog';

/** Рейс Харбин ↔ Петропавловск-Камчатский. */
export const ZH_HARBIN_PATH = '/zh/harbin';

/** Язык раздела — тот же, что в hreflang и `lang` у <main>; next.config.js ставит его заголовком. */
export const ZH_CONTENT_LANGUAGE = 'zh-CN';

/** Индексируемые китайские страницы, пути от корня. */
// Посадочные под запросы (lib/seo/query-landings) — тоже здесь, чтобы попасть в IndexNow.
export const ZH_PAGE_PATHS: readonly string[] = [
  '/zh',
  '/zh/booking',
  '/zh/volcano-tours',
  ZH_CATALOG_PATH,
  ZH_HARBIN_PATH,
];

/** hreflang каталога: русская витрина и китайская, взаимно. */
export function catalogHreflang(site: string): { ru: string; 'zh-CN': string } {
  const root = site.replace(/\/+$/, '');
  return { ru: `${root}/catalog`, 'zh-CN': `${root}${ZH_CATALOG_PATH}` };
}

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
