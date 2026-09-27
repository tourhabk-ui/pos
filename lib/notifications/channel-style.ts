/**
 * Стиль постов в каналах Ведара — один на все шаблоны (решение владельца
 * 27.09: «стили написания, цитирование, жирный заголовок, гиперссылка — пусть
 * посты будут на уровне, мы же передовая платформа»).
 *
 * До этого дня у каждого поста был свой вид: у маршрута — эмодзи-бейджи 🌋 📍
 * 🥾 💰 (правило платформы их запрещает), у оператора — «партнёр TourHab»
 * (прежнее имя), у тура — строка КАПСОМ над заголовком, у места — голый адрес
 * отдельной строкой. Четыре шаблона — четыре вида, и все разные.
 *
 * Стандарт тот же, что у ИИ-канала («Журнал», 27.09):
 *
 *   <b><a href="страница">Заголовок</a></b>   — жирный и сам ведёт на страницу
 *   <i>что это · где</i>                       — курсивом, одной строкой
 *
 *   текст
 *
 *   <blockquote>факты · факты</blockquote>     — плашкой: дни, группа, цена
 *
 * Отсутствующая часть не рисуется вовсе — ни пустой плашки, ни «—»: чего нет
 * в данных, того нет и в посте (§4.0).
 */

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Адрес в href: `&` и кавычка — сущностями, иначе Telegram примет их за разметку. */
export function escHref(url: string): string {
  return url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Заголовок: жирный, со ссылкой на страницу, если она есть. */
export function channelHeadline(title: string, url?: string | null): string {
  const t = escHtml(title.trim());
  return url ? `<b><a href="${escHref(url)}">${t}</a></b>` : `<b>${t}</b>`;
}

/** Подзаголовок курсивом: «Озеро · Треккинг». Пусто — null, строки нет. */
export function channelKicker(parts: Array<string | null | undefined>): string | null {
  const p = parts.map((s) => s?.trim()).filter((s): s is string => !!s);
  return p.length > 0 ? `<i>${escHtml(p.join(' · '))}</i>` : null;
}

/**
 * Плашка фактов. Каждый элемент — строка УЖЕ в HTML (цена может быть жирной),
 * поэтому экранирует вызывающий. Пусто — null.
 */
export function channelFacts(lines: Array<string | null | undefined>): string | null {
  const l = lines.filter((s): s is string => !!s && s.trim().length > 0);
  return l.length > 0 ? `<blockquote>${l.join('\n')}</blockquote>` : null;
}

/** Текстовая ссылка: подпись — ссылка, без голого адреса и стрелок. */
export function channelLink(label: string, url: string): string {
  return `<a href="${escHref(url)}">${escHtml(label)}</a>`;
}

/**
 * Склейка блоков поста пустой строкой; null-блоки выпадают. Внутри блока
 * строки идут подряд (заголовок и подзаголовок — один блок).
 */
export function channelPost(blocks: Array<Array<string | null | undefined> | string | null | undefined>): string {
  return blocks
    .map((b) => (Array.isArray(b) ? b.filter((x): x is string => !!x).join('\n') : b ?? ''))
    .filter((b) => b.trim().length > 0)
    .join('\n\n');
}
