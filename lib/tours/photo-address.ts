/**
 * Адрес снимка тура: что можно сохранить и что можно открыть (план готовности
 * 23.11, этап 4; находка ревью безопасности и её перепроверка 23.11).
 *
 * Адрес снимка приходит от партнёра строкой. Очередь администратора ставит
 * её в `src` превью и в `href` «открыть целиком»; после одобрения та же
 * строка стоит в `src` на карточке тура у каждого туриста.
 *
 * Первая находка (этап 4): `javascript:…` в ссылке админки выполнился бы от
 * имени администратора. Её закрыли правилом «не чужая схема».
 *
 * Перепроверка 23.11 показала, что этого мало. Правило было ОТРИЦАТЕЛЬНЫМ —
 * «всё, кроме чужой схемы», — и пропускало любой путь нашего сайта:
 *   - `/api/admin/…?action=…` — браузер администратора сам запрашивает адрес
 *     как картинку, со своей кукой, без единого нажатия; у части админских
 *     адресов GET что-то делает;
 *   - `/api/auth/magic?token=…` — подмена сессии того, кто открыл страницу;
 *   - `//чужой.хост/…`, `https:чужой.хост/…` — очередь показывала одно, а
 *     карточка туриста разрешала строку в другой адрес;
 *   - `javascript://x y/…` — разбор адреса падал, и «чужой схемы нет».
 *
 * Теперь правило ПОЛОЖИТЕЛЬНОЕ: снимок — это либо путь, по которому сайт
 * раздаёт картинки, либо `https://хост/…`. Остальное не сохраняется и не
 * рисуется. Одно правило на дверь и на экран: что принято, то и показано.
 *
 * Адрес, уже стоящий у тура (старые записи, импорт), дверь оставляет как
 * есть — иначе пилот со старым снимком не смог бы сохранить тур. Экран судит
 * каждый адрес сам и от содержимого базы не зависит.
 *
 * Чистый модуль — его читает и экран (клиентский код).
 */

/** Каталоги сайта, из которых раздаются картинки. GET по ним ничего не меняет. */
const SITE_PHOTO_PREFIX = /^\/(?:images|api\/images|api\/photos)\//;

/**
 * Путь нашего сайта к картинке — либо null.
 *
 * Без строки запроса и якоря: параметрами управляют действия, а не снимки.
 * Без `..` и закодированных точки, слэшей и нуля: путь обязан остаться в
 * своём каталоге, как его ни разбирай.
 */
export function sitePhotoPath(url: string): string | null {
  if (!SITE_PHOTO_PREFIX.test(url)) return null;
  if (!/^[\p{L}\p{N}_./%()+,~-]+$/u.test(url)) return null;
  if (/(?:^|\/)\.\.(?:\/|$)/.test(url)) return null;
  if (/%(?:2e|2f|5c|00)/i.test(url)) return null;
  return url;
}

/**
 * Внешний снимок — только `https://хост/…`, записанный полностью.
 *
 * `https:хост/…` и `https:\\хост` браузер на странице с https читает как
 * относительный путь нашего сайта, а разбор `URL` — как чужой хост: одна
 * строка, два адреса. Поэтому форма записи проверяется до разбора. Имя и
 * пароль в адресе снимку не нужны, а читающего путают (`https://наш@чужой/`).
 */
export function externalPhotoHref(url: string): string | null {
  if (!/^https:\/\/[^/\\\s]/i.test(url)) return null;
  if (/[\s\\\u0000-\u001f]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.href;
}

/**
 * Адрес, который можно поставить в `src` и в ссылку: путь раздачи картинок
 * сайта или `https://`. Иначе null — экран показывает строку текстом, дверь
 * новый адрес не сохраняет.
 */
export function openablePhotoAddress(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return sitePhotoPath(url) ?? externalPhotoHref(url);
}

/**
 * У адреса чужая схема: `javascript:`, `data:`, `vbscript:`, `file:` и любая
 * другая, кроме http(s).
 *
 * Схема читается так, как её прочтёт браузер: табуляции и переводы строк он
 * выбрасывает из адреса целиком, пробелы и управляющие знаки — в начале.
 * Разбору `URL` правило не доверяет: на `javascript://x y/…` он бросает
 * исключение, и прежде это читалось как «схемы нет».
 *
 * Это нижняя граница для адреса, уже лежащего у тура: ни одна дверь не
 * сохраняет чужую схему, даже повторно. Новый адрес судит `openablePhotoAddress`.
 */
export function photoAddressHasForeignScheme(url: string): boolean {
  const seen = url.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(seen)?.[1]?.toLowerCase();
  if (scheme === undefined) return false;
  return scheme !== 'https' && scheme !== 'http';
}

/**
 * Адреса из правки, которые нельзя принять: новые (не стоящие у тура) и не
 * являющиеся снимком. Пустой список — правку можно сохранять.
 *
 * `known` — адреса, которые уже есть у тура: на витрине или в правке на
 * проверке. Их форма присылает обратно при каждом сохранении.
 */
export function rejectedPhotoAddresses(incoming: readonly unknown[], known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const url of incoming) {
    if (typeof url !== 'string') continue;
    if (known.has(url)) continue;
    if (openablePhotoAddress(url) === null) out.push(url);
  }
  return out;
}

/** Адреса снимков из строки тура или правки: `photos` и `tour_image`. */
export function photoAddressesOf(row: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  if (Array.isArray(row?.photos)) for (const u of row.photos) if (typeof u === 'string') out.push(u);
  if (typeof row?.tour_image === 'string') out.push(row.tour_image);
  return out;
}

/** Слова отказа двери: что прислать вместо. */
export const PHOTO_ADDRESS_TEXT = 'Адрес фото — ссылка https:// или фото, загруженное здесь';
