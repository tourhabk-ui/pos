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

const MARKER_ITEM = /^(?:[-•–*]|\d+[.)])\s+(.+)$/;
/** Короткий заголовок: «Однодневные», «Вертолётные туры». Не предложение. */
const HEADING_AT = /^([\p{Lu}][\p{L}\-]{1,28}(?:\s+[\p{L}\-]{2,28}){0,2}):\s+\S/u;

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] };

function isHeadingAt(line: string, from: number): boolean {
  const m = HEADING_AT.exec(line.slice(from));
  if (!m) return false;
  const heading = m[1];
  if (heading.length > 32) return false;
  return heading.split(/\s+/).every((word) => /^[\p{L}\-]{2,}$/u.test(word));
}

/**
 * Строка «Заголовок: …» или несколько таких подряд в одном абзаце.
 * Заголовок в середине предложения («пик сезона: маршруты открыты») не считается:
 * следующий заголовок начинается только после точки, вопроса или восклицания.
 */
function labeledLine(line: string): { prefix: string | null; items: string[] } | null {
  const starts: number[] = [];
  const consider = (index: number) => {
    if (index < line.length && isHeadingAt(line, index)) starts.push(index);
  };
  consider(0);
  for (const mark of line.matchAll(/[.!?]\s+/g)) {
    consider(mark.index + mark[0].length);
  }
  if (starts.length === 0) return null;
  if (starts.length === 1 && starts[0] !== 0) return null;
  const prefix = starts[0] === 0 ? null : line.slice(0, starts[0]).trim() || null;
  const items = starts.map((start, i) => line.slice(start, starts[i + 1] ?? line.length).trim()).filter(Boolean);
  return items.length > 0 ? { prefix, items } : null;
}

/** Строки «- …», «1. …» и «Заголовок: …» — список. Остальное — абзацы. Пустая строка список закрывает. */
export function chatBlocks(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length === 0) return;
    blocks.push({ kind: 'list', items });
    items = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const marker = MARKER_ITEM.exec(line);
    const body = marker ? marker[1] : line;
    const labeled = labeledLine(body);
    if (labeled) {
      if (labeled.prefix) {
        flush();
        blocks.push({ kind: 'text', text: labeled.prefix });
      }
      items.push(...labeled.items);
      continue;
    }
    if (marker) {
      items.push(marker[1]);
      continue;
    }
    flush();
    blocks.push({ kind: 'text', text: line });
  }
  flush();
  return blocks;
}

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
