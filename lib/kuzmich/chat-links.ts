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

const MARKER_ITEM = /^[-•–*]\s+(.+)$/;
/**
 * Пункт с номером: «1. …», «2) …». Номер — до трёх цифр: «1975. Извержение…»
 * — год, а не пункт, и срезать его нельзя (проверка качества 24.10: список
 * извержений терял годы, шаги «1. Позвоните 112» — номера).
 */
const NUMBERED_ITEM = /^(\d{1,3})[.)]\s+(.+)$/;
/** Короткий заголовок: «Однодневные», «Вертолётные туры». Не предложение. */
const HEADING_AT = /^([\p{Lu}][\p{L}\-]{1,28}(?:\s+[\p{L}\-]{2,28}){0,2}):\s+\S/u;

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  /** Нумерованный список: номер остаётся тем, что написан в ответе. */
  | { kind: 'ordered'; items: Array<{ n: number; text: string }> };

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

/**
 * Пункты, слипшиеся в одну строку (тест планировщика 21.11): «…полнее. -
 * Восхождение на Горелый…» на 390 px читалось абзацем с «-», на десктопе
 * пункт прилипал к строке. Маркер « - » после конца предложения — начало
 * нового пункта: переносим его на свою строку. Тире «—» внутри фразы
 * («Горелый — 15 000 ₽») и дефис в слове не трогаем: нужен конец
 * предложения перед маркером и пробелы с обеих сторон.
 */
const INLINE_ITEM = /([.!?…])[ \t]+[-•–][ \t]+(?=[\p{Lu}\d«"(])/gu;

export function expandInlineItems(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!INLINE_ITEM.test(line)) return line;
      INLINE_ITEM.lastIndex = 0;
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      const parts = line.replace(INLINE_ITEM, '$1\n- ').split('\n');
      // Строка без маркера: первая часть — текст, остальное — пункты списка.
      return parts.map((p, i) => (i === 0 ? p : `${indent}${p}`)).join('\n');
    })
    .join('\n');
}

/**
 * Строки «- …» и «Заголовок: …» — список, «1. …» — нумерованный список со
 * своими номерами. Остальное — абзацы. Пустая строка список закрывает.
 */
export function chatBlocks(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let items: string[] = [];
  let steps: Array<{ n: number; text: string }> = [];
  const flush = () => {
    if (items.length > 0) blocks.push({ kind: 'list', items });
    if (steps.length > 0) blocks.push({ kind: 'ordered', items: steps });
    items = [];
    steps = [];
  };
  for (const raw of expandInlineItems(text).split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const numbered = NUMBERED_ITEM.exec(line);
    if (numbered) {
      if (items.length > 0) flush();
      steps.push({ n: Number(numbered[1]), text: numbered[2] });
      continue;
    }
    if (steps.length > 0) flush();
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

/**
 * Свой путь: одна косая черта, за которой не косая и не обратная косая.
 * Иначе браузер прочтёт адрес как чужой хост: «//evil.example» — адрес без
 * схемы, а косую с обратной косой браузеры нормализуют в те же две косые.
 * До 26.11 ссылка «[Оплата на vedarai.ru](/» + обратная косая + «evil.example)»
 * проходила как своя и открывала чужой сайт под любой
 * подписью — путь к фишингу «оплатите по ссылке» (проверка безопасности ИИ-части,
 * слово владельца «чини Карт бланш»). Тот же обход — у своего хоста с путём
 * «//…»: такой адрес остаётся полным, на нашем хосте.
 */
const OWN_PATH_RE = /^\/(?![\/\\])/;

/** Адрес своего хоста: путь, если он свой; иначе полный адрес на нашем хосте. */
function ownHostHref(url: URL): string {
  return OWN_PATH_RE.test(url.pathname) ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

/**
 * Ссылка «[текст](адрес)» — так сервер подписывает туры в ответе ссылкой на
 * их страницу (21.11, тест планировщика). Адрес — свой путь «/…» или http(s);
 * прочие схемы остаются текстом.
 */
const MD_LINK_RE = /\[([^\]\n]{1,200})\]\((\/[^\s()]*|https?:\/\/[^\s()]+)\)/g;

export function chatLinkChunks(text: string): ChatChunk[] {
  const out: ChatChunk[] = [];
  let last = 0;
  for (const m of text.matchAll(MD_LINK_RE)) {
    const start = m.index ?? 0;
    const label = m[1];
    const target = m[2];
    let chunk: ChatChunk | null = null;
    if (target.startsWith('/')) {
      // Две косые или косая с обратной косой — не свой путь: ссылкой не
      // становятся, остаются текстом.
      chunk = OWN_PATH_RE.test(target) ? { text: label, href: target } : null;
    } else {
      try {
        const url = new URL(target);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          chunk = OWN_HOSTS.has(url.hostname.toLowerCase())
            ? { text: label, href: ownHostHref(url) }
            : { text: label, href: url.href, external: true };
        }
      } catch { chunk = null; }
    }
    if (!chunk) continue;
    if (start > last) out.push(...plainLinkChunks(text.slice(last, start)));
    out.push(chunk);
    last = start + m[0].length;
  }
  if (last < text.length) out.push(...plainLinkChunks(text.slice(last)));
  return out;
}

function plainLinkChunks(text: string): ChatChunk[] {
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
      ? { text: raw, href: ownHostHref(url) }
      : { text: raw, href: url.href, external: true });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
