/**
 * Контекстные ссылки в теле посадочных (Сыщик, 22.11): фразы из уже
 * написанного текста становятся ссылками по одной карте, без правки
 * каждого файла текстов. Заголовки и раздел «Источники» не трогаем.
 * Повторно тот же адрес на странице не ставим; подпись, которая уже
 * есть в блоке «Читайте также», не используем.
 */
import type { Block, Inline } from '@/lib/articles/markdown';

/** Точные фрагменты тела → адрес. Более длинные фразы в списке — раньше. */
export const CONTEXTUAL_LINK_RULES: readonly {
  href: string;
  phrases: readonly string[];
}[] = [
  {
    href: '/prepare',
    phrases: [
      'регистрацию туристического маршрута в МЧС',
      'регистрация туристического маршрута в МЧС',
      'зарегистрируйте маршрут в МЧС',
      'регистрация маршрута в МЧС',
      'зарегистрировать в МЧС',
      'регистрировать в МЧС',
      'Регистрация в МЧС',
      'регистрация в МЧС',
      'регистрацию в МЧС',
    ],
  },
  {
    href: '/medvedi-kamchatki',
    phrases: [
      'крупная группировка бурых медведей',
      'группировка бурых медведей',
      'больше 200 бурых медведей',
      'бурых медведей',
    ],
  },
  {
    href: '/fish',
    phrases: [
      'зимняя рыбалка на Камчатке',
      'зимней рыбалки на Камчатке',
      'Сезон зимней рыбалки',
      'сезон зимней рыбалки',
      'морская рыбалка',
      'Морская рыбалка',
      'для рыбалки',
      'Для рыбалки',
    ],
  },
];

const SOURCES_H2 = /^источники$/i;

export const CONTEXTUAL_LINK_LIMIT = 5;

export interface ContextualLinkState {
  currentPath: string;
  /** Подписи из «Читайте также» — такие якоря в теле не ставим. */
  reservedAnchors: ReadonlySet<string>;
  used: Set<string>;
  added: number;
  limit: number;
}

export function createContextualLinkState(opts: {
  currentPath: string;
  reservedAnchors?: Iterable<string>;
  alreadyLinked?: Iterable<string>;
  limit?: number;
}): ContextualLinkState {
  return {
    currentPath: pathOnly(opts.currentPath),
    reservedAnchors: new Set(opts.reservedAnchors ?? []),
    used: new Set([...(opts.alreadyLinked ?? [])].map(pathOnly)),
    added: 0,
    limit: opts.limit ?? CONTEXTUAL_LINK_LIMIT,
  };
}

/** Куски текста с необязательным адресом — для JSX на страницах вроде /plans. */
export function applyExactTextLinks(
  text: string,
  links: readonly { text: string; href: string }[],
): Array<{ text: string; href?: string }> {
  const hits: { start: number; end: number; href: string }[] = [];
  const sorted = [...links].sort((a, b) => b.text.length - a.text.length);
  for (const link of sorted) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(link.text, from);
      if (start < 0) break;
      const end = start + link.text.length;
      if (hasLetterBeforeOrAfter(text, start, end)) {
        from = start + 1;
        continue;
      }
      if (hits.some((h) => start < h.end && end > h.start)) {
        from = end;
        continue;
      }
      hits.push({ start, end, href: link.href });
      from = end;
    }
  }
  hits.sort((a, b) => a.start - b.start);
  if (hits.length === 0) return [{ text }];
  const parts: Array<{ text: string; href?: string }> = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start > cursor) parts.push({ text: text.slice(cursor, h.start) });
    parts.push({ text: text.slice(h.start, h.end), href: h.href });
    cursor = h.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

export function applyContextualLinks(
  before: Block[],
  after: Block[],
  opts: { currentPath: string; reservedAnchors?: Iterable<string>; limit?: number },
): { before: Block[]; after: Block[] } {
  const already = [
    ...collectLinkedHrefs(before, { skipSources: true }),
    ...collectLinkedHrefs(after, { skipSources: true }),
  ];
  const state = createContextualLinkState({
    currentPath: opts.currentPath,
    reservedAnchors: opts.reservedAnchors,
    alreadyLinked: already,
    limit: opts.limit,
  });
  return {
    before: linkifyBlocks(before, state),
    after: linkifyBlocks(after, state),
  };
}

export function collectLinkedHrefs(blocks: readonly Block[], opts?: { skipSources?: boolean }): string[] {
  const hrefs: string[] = [];
  let inSources = false;
  const take = (nodes: readonly Inline[]) => {
    walkLinks(nodes, (href) => {
      if (href.startsWith('/')) hrefs.push(pathOnly(href));
    });
  };
  for (const b of blocks) {
    if (b.t === 'h2' && SOURCES_H2.test(b.text)) inSources = true;
    if (opts?.skipSources && inSources) continue;
    switch (b.t) {
      case 'h2':
      case 'h3':
      case 'p':
        take(b.c);
        break;
      case 'ul':
      case 'ol':
        b.items.forEach(take);
        break;
      case 'table':
        b.head.forEach(take);
        b.rows.forEach((r) => r.forEach(take));
        break;
      case 'qa':
        take(b.q);
        b.a.forEach(take);
        break;
    }
  }
  return hrefs;
}

function linkifyBlocks(blocks: readonly Block[], state: ContextualLinkState): Block[] {
  let inSources = false;
  return blocks.map((b) => {
    if (b.t === 'h2' && SOURCES_H2.test(b.text)) inSources = true;
    if (inSources || b.t === 'h2' || b.t === 'h3' || b.t === 'table') return b;
    switch (b.t) {
      case 'p':
        return { ...b, c: linkifyNodes(b.c, state) };
      case 'ul':
      case 'ol':
        return { ...b, items: b.items.map((it) => linkifyNodes(it, state)) };
      case 'qa':
        return { ...b, a: b.a.map((p) => linkifyNodes(p, state)) };
      default:
        return b;
    }
  });
}

function linkifyNodes(nodes: readonly Inline[], state: ContextualLinkState): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    if (n.t === 'link') {
      if (n.href.startsWith('/')) state.used.add(pathOnly(n.href));
      out.push(n);
      continue;
    }
    if (n.t === 'ref') {
      out.push(n);
      continue;
    }
    if (n.t === 'strong' || n.t === 'em') {
      out.push({ ...n, c: linkifyNodes(n.c, state) });
      continue;
    }
    out.push(...linkifyTextNode(n.v, state));
  }
  return out;
}

function linkifyTextNode(text: string, state: ContextualLinkState): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest.length > 0) {
    const hit = findMatch(rest, state);
    if (!hit) {
      out.push({ t: 'text', v: rest });
      break;
    }
    if (hit.start > 0) out.push({ t: 'text', v: rest.slice(0, hit.start) });
    out.push({ t: 'link', href: hit.href, c: [{ t: 'text', v: rest.slice(hit.start, hit.end) }] });
    state.used.add(hit.href);
    state.added += 1;
    rest = rest.slice(hit.end);
  }
  return out;
}

function findMatch(text: string, state: ContextualLinkState): { start: number; end: number; href: string } | null {
  if (state.added >= state.limit) return null;
  let best: { start: number; end: number; href: string; len: number } | null = null;
  for (const rule of CONTEXTUAL_LINK_RULES) {
    if (pathOnly(rule.href) === state.currentPath) continue;
    if (state.used.has(pathOnly(rule.href))) continue;
    for (const phrase of rule.phrases) {
      if (state.reservedAnchors.has(phrase)) continue;
      let from = 0;
      while (from <= text.length) {
        const start = text.indexOf(phrase, from);
        if (start < 0) break;
        const end = start + phrase.length;
        if (hasLetterBeforeOrAfter(text, start, end)) {
          from = start + 1;
          continue;
        }
        if (!best || start < best.start || (start === best.start && phrase.length > best.len)) {
          best = { start, end, href: rule.href, len: phrase.length };
        }
        break;
      }
    }
  }
  return best ? { start: best.start, end: best.end, href: best.href } : null;
}

function hasLetterBeforeOrAfter(text: string, start: number, end: number): boolean {
  if (start > 0 && /\p{L}/u.test(text[start - 1]!)) return true;
  if (end < text.length && /\p{L}/u.test(text[end]!)) return true;
  return false;
}

function walkLinks(nodes: readonly Inline[], visit: (href: string) => void): void {
  for (const n of nodes) {
    if (n.t === 'link') visit(n.href);
    else if (n.t === 'strong' || n.t === 'em') walkLinks(n.c, visit);
  }
}

function pathOnly(href: string): string {
  const path = href.split('#')[0] ?? href;
  return path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
}
