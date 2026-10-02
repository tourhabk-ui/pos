/**
 * Возврат в каталог на то же место (голосовой запрос владельца 01.10).
 *
 * Турист долистал /routes до пятой страницы, открыл маршрут, понял, что не
 * поедет, закрыл карточку — и оказался на первой странице у первой локации.
 * Терялось всё сразу: страница (ссылка «Маршруты» в карточке вела на голый
 * /routes), фильтры (сложность, цена, радиус и сортировка в адрес не
 * писались) и прокрутка (скелет `loading.tsx` отрисовывался раньше списка,
 * и браузеру было некуда возвращать прокрутку).
 *
 * Здесь — чистые правила, без React: что считать адресом списка, куда
 * можно возвращать и как ужать номер страницы, которой больше нет.
 * Хранилище — sessionStorage: живёт ровно столько, сколько вкладка, и для
 * удобства возврата этого достаточно; его отсутствие (приватный режим,
 * запрет данных сайта) — штатное состояние, а не отказ: тогда возврат идёт
 * на раздел, как раньше.
 */

export const CATALOG_RETURN_KEY = 'catalog-return';

/** Разделы, в которые можно возвращаться по сохранённому адресу. */
const LIST_PREFIXES = ['/routes', '/places'] as const;

export interface CatalogReturn {
  /** Адрес списка: путь с параметрами, без хоста. */
  url: string;
  /** Прокрутка списка в момент ухода в карточку. */
  scrollY: number;
  /** Когда записано (мс) — старая запись не должна уводить вниз через час. */
  at: number;
}

/** Сколько живёт запись о прокрутке: дольше — турист уже не «вернулся». */
export const CATALOG_RETURN_TTL_MS = 30 * 60 * 1000;

/**
 * Адрес списка годится для возврата, только если это наш раздел каталога:
 * относительный путь, начинающийся с /routes или /places (сам раздел,
 * `?`-параметры), но не карточка под ним и не `//host`.
 */
export function isCatalogListUrl(url: string): boolean {
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  const path = url.split('?')[0];
  return LIST_PREFIXES.some(p => path === p);
}

/**
 * Номер страницы, которая есть на самом деле: запросили седьмую из пяти —
 * последняя, а не первая и не пустая. `pages` 0 (выдача пуста) — номер не
 * трогается: ужимать не к чему, и пустой результат внутри открытого фильтра
 * остаётся на своей странице.
 */
export function clampPage(page: number, pages: number): number {
  if (!Number.isFinite(pages) || pages < 1) return page;
  return page > pages ? pages : page;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    // Доступ к хранилищу запрещён настройками браузера — удобства нет,
    // каталог от этого не ломается.
    return null;
  }
}

/** Запомнить, откуда турист ушёл в карточку. */
export function rememberCatalogReturn(url: string, scrollY: number, now = Date.now(), store = storage()): void {
  if (!store || !isCatalogListUrl(url)) return;
  const entry: CatalogReturn = { url, scrollY: Math.max(0, Math.round(scrollY)), at: now };
  try {
    store.setItem(CATALOG_RETURN_KEY, JSON.stringify(entry));
  } catch {
    // Квота или приватный режим — см. выше.
  }
}

export function readCatalogReturn(now = Date.now(), store = storage()): CatalogReturn | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(CATALOG_RETURN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const { url, scrollY, at } = v as Record<string, unknown>;
    if (typeof url !== 'string' || !isCatalogListUrl(url)) return null;
    if (typeof scrollY !== 'number' || typeof at !== 'number') return null;
    if (now - at > CATALOG_RETURN_TTL_MS) return null;
    return { url, scrollY, at };
  } catch {
    return null;
  }
}

/**
 * Куда вести ссылку «назад к маршрутам» из карточки: на сохранённый адрес
 * списка, если он есть и он наш; иначе — на раздел.
 */
export function catalogReturnHref(fallback: string, now = Date.now(), store = storage()): string {
  return readCatalogReturn(now, store)?.url ?? fallback;
}

/**
 * Прокрутка для списка по адресу `url`, один раз: запись стирается, чтобы
 * следующий заход на тот же адрес из шапки открывал список сверху.
 * Адрес другой (турист ушёл на другую страницу или фильтр) — null, запись
 * остаётся: ссылка «назад» из карточки ею ещё воспользуется.
 */
export function takeCatalogScroll(url: string, now = Date.now(), store = storage()): number | null {
  const entry = readCatalogReturn(now, store);
  if (!entry || entry.url !== url) return null;
  try {
    store?.removeItem(CATALOG_RETURN_KEY);
  } catch {
    // Не стёрлось — повторный заход прокрутит ещё раз; хуже не станет.
  }
  return entry.scrollY;
}
