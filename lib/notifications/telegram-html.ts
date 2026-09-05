/**
 * lib/notifications/telegram-html.ts — разметка Telegram HTML, которую Bot API
 * примет. ОДНА реализация на всех отправителей.
 *
 * 05.09, пост в ИИ-канал не ушёл: `Bot API 400: can't parse entities: Can't
 * find end tag corresponding to start tag "blockquote"`. Отправитель резал
 * текст вслепую — `text.substring(0, 4096)` — и хвостовой `</blockquote>`
 * отвалился. Так резали ЧЕТЫРЕ отправителя в разных файлах, каждый со своим
 * потолком (4000 или 4096), и ни один не смотрел, что режет.
 *
 * Правило: срез идёт по границе слова ВНЕ тега, а всё, что осталось открытым,
 * закрывается в обратном порядке. Лишний закрывающий тег без пары
 * выбрасывается. Итог всегда влезает в потолок и всегда сбалансирован.
 *
 * Телеграм знает ограниченный набор тегов (parse_mode=HTML): b/strong, i/em,
 * u/ins, s/strike/del, span (только class="tg-spoiler"), tg-spoiler, a, code,
 * pre, blockquote (с expandable), tg-emoji. Незнакомый тег Bot API тоже не
 * примет — он попадает в диагноз, а не чинится молча: незнакомый тег значит,
 * что модель нарушила формат, и об этом надо знать.
 */

const TELEGRAM_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote', 'tg-emoji',
]);

/** Лимит sendMessage в Bot API. */
export const TELEGRAM_TEXT_LIMIT = 4096;

const TAG_RX = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?>/g;

interface TagToken { start: number; end: number; closing: boolean; name: string; raw: string }

function tokens(text: string): TagToken[] {
  const out: TagToken[] = [];
  for (const m of text.matchAll(TAG_RX)) {
    out.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      closing: m[1] === '/',
      name: m[2].toLowerCase(),
      raw: m[0],
    });
  }
  return out;
}

/**
 * Что не так с разметкой — словами, или null, если Bot API её примет.
 * Судит три вещи: незнакомый тег, закрывающий без открывающего, открытый без
 * закрывающего. Диагноз, а не починка: чинит `repairTelegramHtml`.
 */
export function telegramHtmlIssue(text: string): string | null {
  const stack: string[] = [];
  for (const t of tokens(text)) {
    if (!TELEGRAM_TAGS.has(t.name)) return `тег <${t.name}> Telegram не знает`;
    if (!t.closing) { stack.push(t.name); continue; }
    const top = stack[stack.length - 1];
    if (top !== t.name) {
      return top
        ? `закрывающий </${t.name}> при открытом <${top}>`
        : `закрывающий </${t.name}> без открывающего`;
    }
    stack.pop();
  }
  if (stack.length > 0) return `не закрыт <${stack[stack.length - 1]}>`;
  return null;
}

/**
 * Срезать под потолок Bot API и сбалансировать теги.
 *
 * Срез — по последнему пробелу ВНЕ тега перед потолком, с запасом под
 * закрывающие теги. Оставшиеся открытые теги закрываются в обратном порядке,
 * закрывающие без пары выбрасываются. Незнакомые теги НЕ трогаются: их
 * называет `telegramHtmlIssue`, и решение о них принимает вызывающий.
 */
export function repairTelegramHtml(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string {
  const src = String(text ?? '');
  // Запас под хвост закрывающих тегов: `</blockquote>` — 13 знаков, глубина
  // вложенности в живых постах не больше трёх.
  const reserve = 48;
  const hardCut = src.length > limit ? Math.max(0, limit - reserve) : src.length;

  // Точка среза не должна попасть внутрь тега.
  let cut = hardCut;
  if (cut < src.length) {
    for (const t of tokens(src)) {
      if (t.start < cut && t.end > cut) { cut = t.start; break; }
      if (t.start >= cut) break;
    }
    // По границе слова, если она есть в разумной близости.
    const ws = src.lastIndexOf(' ', cut);
    const nl = src.lastIndexOf('\n', cut);
    const boundary = Math.max(ws, nl);
    if (boundary > cut - 200 && boundary > 0) cut = boundary;
  }

  // Второй проход: собрать текст, выбрасывая закрывающие без пары, и запомнить
  // открытые.
  const body = src.slice(0, cut);
  const stack: string[] = [];
  let out = '';
  let pos = 0;
  for (const t of tokens(body)) {
    out += body.slice(pos, t.start);
    pos = t.end;
    if (!TELEGRAM_TAGS.has(t.name)) { out += t.raw; continue; }
    if (!t.closing) { stack.push(t.name); out += t.raw; continue; }
    const idx = stack.lastIndexOf(t.name);
    if (idx === -1) continue;                        // лишний закрывающий — выбросить
    // Закрыть всё, что открыто поверх него (перекрёстные теги Bot API не примет).
    while (stack.length > idx + 1) out += `</${stack.pop()}>`;
    stack.pop();
    out += t.raw;
  }
  out += body.slice(pos);
  out = out.replace(/\s+$/, '');
  if (cut < src.length) out += '…';
  while (stack.length > 0) out += `</${stack.pop()}>`;
  return out;
}
