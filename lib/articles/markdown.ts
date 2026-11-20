/**
 * Разметка переписанных статей (миграция 1471): тексты хранятся в markdown —
 * короткий ответ, разделы `##`, абзацы, списки, таблицы, ссылки, сноски [n].
 *
 * Свой маленький разборщик, а не библиотека: формат текстов узкий и известен
 * (рабочая папка Сыщика, 27 статей), HTML из текста не пропускается вовсе —
 * всё, что не разметка, остаётся текстом, и React его экранирует. Ссылки —
 * только http(s) и относительные пути: `javascript:` и прочее станет текстом.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'ref'; n: number };

export type Block =
  | { t: 'h2'; c: Inline[]; text: string }
  | { t: 'h3'; c: Inline[]; text: string }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'qa'; q: Inline[]; qText: string; a: Inline[][] };

const SITE_RE = /^https?:\/\/(?:www\.)?vedarai\.ru(?=\/|$)/i;

/** Адрес ссылки — допустимый или null (тогда ссылка остаётся текстом). */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (SITE_RE.test(href)) return href.replace(SITE_RE, '') || '/';
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^\/(?!\/)[^\s]*$/.test(href)) return href;
  return null;
}

/** Строка → inline-узлы: **жирный**, *курсив*, [текст](адрес), голый http(s), [n]. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\*\*(.+?)\*\*/))) {
      flush(); out.push({ t: 'strong', c: parseInline(m[1]) }); i += m[0].length; continue;
    }
    if ((m = rest.match(/^\*(?!\s)([^*]+?)\*/))) {
      flush(); out.push({ t: 'em', c: parseInline(m[1]) }); i += m[0].length; continue;
    }
    if ((m = rest.match(/^\[(\d{1,3})\]/))) {
      flush(); out.push({ t: 'ref', n: Number(m[1]) }); i += m[0].length; continue;
    }
    if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      const href = safeHref(m[2]);
      flush();
      if (href) out.push({ t: 'link', href, c: parseInline(m[1]) });
      else out.push(...parseInline(m[1]));
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^https?:\/\/[^\s<>()]+[^\s<>().,;:!?»"']/i)) && !/[\p{L}\p{N}]$/u.test(buf)) {
      const href = safeHref(m[0]);
      flush();
      if (href) out.push({ t: 'link', href, c: [{ t: 'text', v: m[0] }] });
      else buf += m[0];
      i += m[0].length; continue;
    }
    buf += src[i]; i += 1;
  }
  flush();
  return out;
}

/** Inline-узлы → простой текст (для JSON-LD, сниппета, оглавления). Сноски опускаются. */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => {
    if (n.t === 'text') return n.v;
    if (n.t === 'ref') return '';
    return inlineText(n.c);
  }).join('').replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** Текст статьи → блоки. Вопрос-ответ — строка `**…?**` и следующие за ней абзацы до пустой строки. */
export function parseArticleMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^###\s+(.+)$/))) {
      const c = parseInline(m[1].trim()); blocks.push({ t: 'h3', c, text: inlineText(c) }); i += 1; continue;
    }
    if ((m = line.match(/^##\s+(.+)$/))) {
      const c = parseInline(m[1].trim()); blocks.push({ t: 'h2', c, text: inlineText(c) }); i += 1; continue;
    }
    if (/^#\s/.test(line)) { i += 1; continue; } // H1 — в заголовке страницы, не в теле
    if (/^\s*\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i += 1; }
      const isSep = (r: string) => cells(r).every((c) => /^:?-{2,}:?$/.test(c));
      const head = rows.length > 1 && isSep(rows[1]) ? cells(rows[0]) : null;
      const body = rows.filter((r, k) => !(head && k <= 1) && !isSep(r));
      blocks.push({ t: 'table', head: (head ?? []).map(parseInline), rows: body.map((r) => cells(r).map(parseInline)) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*[-*]\s+/, '').trim())); i += 1;
      }
      blocks.push({ t: 'ul', items }); continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*\d+\.\s+/, '').trim())); i += 1;
      }
      blocks.push({ t: 'ol', items }); continue;
    }
    if ((m = line.match(/^\*\*(.+\?)\*\*\s*$/))) {
      const q = parseInline(m[1]);
      i += 1;
      const a: Inline[][] = [];
      while (i < lines.length && lines[i].trim() && !/^(#|\||\s*[-*]\s|\s*\d+\.\s|\*\*.+\?\*\*\s*$)/.test(lines[i])) {
        a.push(parseInline(lines[i].trim())); i += 1;
      }
      blocks.push({ t: 'qa', q, qText: inlineText(q), a }); continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*\||\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])
      && !/^\*\*.+\?\*\*\s*$/.test(lines[i])) {
      para.push(lines[i].trim()); i += 1;
    }
    blocks.push({ t: 'p', c: parseInline(para.join(' ')) });
  }
  return blocks;
}

/** Пары вопрос-ответ раздела «Частые вопросы» — для FAQPage. Ответы — простым текстом. */
export function faqFromBlocks(blocks: Block[]): Array<{ q: string; a: string }> {
  return blocks
    .filter((b): b is Extract<Block, { t: 'qa' }> => b.t === 'qa')
    .map((b) => ({ q: b.qText, a: b.a.map(inlineText).join(' ').trim() }))
    .filter((x) => x.q && x.a);
}

/** Короткий ответ (абзац «**Коротко.** …») простым текстом — для выдержки на оглавлении. */
export function shortAnswer(blocks: Block[]): string | null {
  for (const b of blocks) {
    if (b.t !== 'p') continue;
    const first = b.c[0];
    if (first?.t === 'strong' && /^коротко\.?$/i.test(inlineText(first.c))) {
      return inlineText(b.c.slice(1)) || null;
    }
  }
  return null;
}
