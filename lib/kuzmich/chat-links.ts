/**
 * lib/kuzmich/chat-links.ts
 *
 * Ссылки в ответе Кузьмича — кликабельными (владелец 03.10: «ссылка в чате
 * не активная»). Ответ модели — простой текст, и `https://vedarai.ru/routes/…`
 * в нём стоял строкой, которую на телефоне не скопировать и не нажать.
 *
 * Чистая нарезка без React: текст → куски «текст» / «ссылка».
 * - Только http(s): `javascript:` и прочие схемы ссылкой не станут никогда —
 *   текст ответа складывает модель, а модель можно уговорить.
 * - Хвостовая пунктуация («…маршрут.», «(ссылка)») в адрес не входит.
 * - Свой домен (vedarai.ru) отдаётся путём — переход внутри приложения, без
 *   новой вкладки и без потери офлайн-кэша.
 */

export interface ChatChunk {
  text: string;
  /** Для ссылки: куда вести. Внутренний путь начинается с «/». */
  href?: string;
  external?: boolean;
}

const URL_RE = /https?:\/\/[^\s<>"«»]+/gi;
const TRAILING = /[.,;:!?)\]}»'"]+$/;
const OWN_HOSTS = new Set(['vedarai.ru', 'www.vedarai.ru']);

export function chatLinkChunks(text: string): ChatChunk[] {
  const out: ChatChunk[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let raw = m[0];
    const tail = raw.match(TRAILING)?.[0] ?? '';
    // Закрывающая скобка остаётся в адресе, если в нём есть открывающая
    // (вики-адреса вида …_(вулкан)).
    if (tail && !(tail.startsWith(')') && raw.slice(0, -tail.length).includes('('))) {
      raw = raw.slice(0, -tail.length);
    }
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    const own = OWN_HOSTS.has(url.hostname.toLowerCase());
    out.push(own
      ? { text: raw, href: `${url.pathname}${url.search}${url.hash}` || '/' }
      : { text: raw, href: url.href, external: true });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
