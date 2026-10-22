/**
 * Наблюдение за сайтами партнёров — чистые правила, без сети и базы.
 *
 * Слово владельца 22.10: «нам нужно проверять сайты партнеров на изменение».
 * Туры партнёров у нас собраны с их сайтов: у туров «Края Вулканов» (1176) и
 * «Местечка Камчатка» (1217) записан `source_url`, туры «Камчатской рыбалки»
 * сверены с её сайтом без адресов страниц (1106, сайт на Tilda — одна
 * страница). Партнёр поменял у себя цену, даты, состав или снял тур —
 * наша карточка стала неправдой, и раньше этого не замечал никто (§0). Ночная
 * проверка сайтов операторов (`operator-site-audit`) смотрит безопасность и с
 * прошлым разом не сравнивает.
 *
 * Здесь — из чего состоит сравнение: видимый текст страницы строками, разница
 * двух текстов, вердикт по истории страницы и сообщение владельцу. Сеть и
 * запись снимков — в `site-watch-run.ts`.
 */
import { createHash } from 'node:crypto';
import { htmlToText } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';
import { escapeHtml } from '@/lib/text/escape-html';

/** Имя, под которым мы читаем чужой сайт. Своё, а не браузер и не поисковик. */
export const WATCH_USER_AGENT = 'VedarSiteWatch/1.0 (+https://vedarai.ru)';

/** Потолок сохраняемого текста страницы, знаков. */
export const TEXT_CAP = 60_000;

/** Исход чтения страницы. */
export type PageOutcome = 'ok' | 'gone' | 'failed' | 'robots';

/**
 * Видимый текст страницы строками: без скриптов, стилей и разметки, сущности
 * развёрнуты, пробелы схлопнуты, пустые строки выброшены. Сравнивается именно
 * он — смена вёрстки, счётчиков в скриптах и CDN-адресов изменением не
 * считается, смена цены или даты в тексте — считается.
 */
export function pageText(html: string): string {
  const text = decodeHtmlEntities(htmlToText(html))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(Number(d)));
  const lines = text.split('\n')
    .map((l) => l.replace(/[\s ]+/g, ' ').trim())
    .filter((l) => l.length > 0);
  return lines.join('\n').slice(0, TEXT_CAP);
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

export function textHash(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

/** Строка про деньги или сроки — её владелец должен увидеть первой. */
// `\b` в JS видит границу только у латиницы — у кириллицы граница задана
// просмотром назад: «марта» в «Камартане» месяцем не считается.
const MATTERS = /₽|руб|\d{1,3}[  ]\d{3}|\b\d{1,2}[./]\d{1,2}\b|(?<![а-яё])(январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)|\b20\d\d\b|\d+\s*(дн|ноч|час)/i;

export interface TextDiff {
  /** Были и пропали. */
  removed: string[];
  /** Появились. */
  added: string[];
}

/**
 * Разница двух текстов по строкам. Строки про деньги и сроки — впереди,
 * остальные — в порядке страницы. Порядок строк сам по себе изменением не
 * считается: перестановка блоков на странице не меняет того, что там сказано.
 */
export function diffLines(prev: string, next: string): TextDiff {
  const a = prev.split('\n');
  const b = next.split('\n');
  const inB = new Set(b);
  const inA = new Set(a);
  const removed = [...new Set(a.filter((l) => !inB.has(l)))];
  const added = [...new Set(b.filter((l) => !inA.has(l)))];
  const first = (xs: string[]) => [...xs.filter((l) => MATTERS.test(l)), ...xs.filter((l) => !MATTERS.test(l))];
  return { removed: first(removed), added: first(added) };
}

/**
 * Запрещает ли robots.txt наш путь. Группа нашего имени, иначе группа `*`;
 * побеждает самое длинное совпавшее правило, Allow — при равной длине.
 * Пустой или недоступный robots.txt ничего не запрещает.
 */
export function robotsDisallows(robotsTxt: string | null, path: string, agent = 'vedarsitewatch'): boolean {
  if (!robotsTxt) return false;
  interface Group { agents: string[]; rules: Array<{ allow: boolean; prefix: string }> }
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'disallow' || key === 'allow') && cur) {
      lastWasAgent = false;
      if (key === 'disallow' && value === '') continue;
      cur.rules.push({ allow: key === 'allow', prefix: value });
    } else {
      lastWasAgent = false;
    }
  }
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!matchesRobotsPath(r.prefix, path)) continue;
      const len = r.prefix.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
  }
  return best ? !best.allow : false;
}

function matchesRobotsPath(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

/** Снимок страницы — то, что о ней знает история. */
export interface Snapshot { outcome: PageOutcome; hash: string | null }

/** Что случилось со страницей по сравнению с прошлыми прогонами. */
export type WatchEvent =
  | { kind: 'baseline' }
  | { kind: 'same' }
  | { kind: 'changed' }
  | { kind: 'gone' }
  | { kind: 'back' }
  | { kind: 'failing' }
  | { kind: 'quiet' };

/**
 * Вердикт по истории. `prev` — прошлый снимок, `prevOk` — последний удачный
 * с текстом (с ним сравнивается текст), `prev2` — позапрошлый.
 *
 *  - первый удачный снимок — точка отсчёта, тревоги нет;
 *  - текст другой, чем в последнем удачном, — «изменилась»;
 *  - 404/410 впервые — «пропала»; пропала и пропала — молчим, уже сказано;
 *  - снова открылась после «пропала» — «вернулась»;
 *  - не открылась второй прогон подряд — «не открывается» (один отказ сети
 *    тревогой не считается), дальше молчим;
 *  - robots.txt запретил — не читали, это не изменение.
 */
export function watchEvent(now: Snapshot, prev: Snapshot | null, prev2: Snapshot | null, prevOkHash: string | null): WatchEvent {
  if (now.outcome === 'robots') return { kind: 'quiet' };
  if (now.outcome === 'gone') return prev?.outcome === 'gone' ? { kind: 'quiet' } : { kind: 'gone' };
  if (now.outcome === 'failed') {
    return prev?.outcome === 'failed' && prev2?.outcome !== 'failed' ? { kind: 'failing' } : { kind: 'quiet' };
  }
  if (prev?.outcome === 'gone') return { kind: 'back' };
  if (prevOkHash === null) return { kind: 'baseline' };
  return now.hash === prevOkHash ? { kind: 'same' } : { kind: 'changed' };
}

/** Страница под наблюдением: чья и каким нашим турам служит источником. */
export interface WatchedPage {
  url: string;
  partnerName: string;
  /** Названия наших живых туров, собранных с этой страницы; пусто — главная. */
  tours: string[];
}

export interface PageReport {
  page: WatchedPage;
  event: WatchEvent['kind'];
  diff?: TextDiff;
  httpStatus?: number | null;
}

const SHOW_LINES = 4;
const MESSAGE_CAP = 3600;

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function what(page: WatchedPage): string {
  if (page.tours.length === 0) return 'главная страница сайта';
  if (page.tours.length === 1) return `тур «${page.tours[0]}»`;
  return `туры ${page.tours.map((t) => `«${t}»`).join(', ')}`;
}

/**
 * Сообщение владельцу. null — сообщать нечего: точки отсчёта, «без перемен»
 * и молчащие исходы в Telegram не идут. Текст — HTML для parse_mode, всё
 * чужое экранировано: строки с сайта партнёра — не наша разметка.
 */
export function ownerMessage(reports: PageReport[]): string | null {
  const loud = reports.filter((r) => r.event === 'changed' || r.event === 'gone' || r.event === 'back' || r.event === 'failing');
  if (loud.length === 0) return null;
  const blocks: string[] = [];
  for (const r of loud) {
    const head = `<b>${escapeHtml(r.page.partnerName)}</b> — ${escapeHtml(what(r.page))}`;
    const url = escapeHtml(shortUrl(r.page.url));
    if (r.event === 'gone') {
      blocks.push(`${head}\nстраница пропала с сайта партнёра (${r.httpStatus ?? 404})\n${url}`);
    } else if (r.event === 'back') {
      blocks.push(`${head}\nстраница снова открывается\n${url}`);
    } else if (r.event === 'failing') {
      blocks.push(`${head}\nстраница не открывается второй день${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}\n${url}`);
    } else {
      const d = r.diff ?? { removed: [], added: [] };
      const lines = [
        ...d.removed.slice(0, SHOW_LINES).map((l) => `было: ${escapeHtml(cut(l))}`),
        ...d.added.slice(0, SHOW_LINES).map((l) => `стало: ${escapeHtml(cut(l))}`),
      ];
      const rest = Math.max(0, d.removed.length - SHOW_LINES) + Math.max(0, d.added.length - SHOW_LINES);
      if (rest > 0) lines.push(`и ещё строк: ${rest}`);
      blocks.push(`${head}\n${url}\n${lines.join('\n')}`);
    }
  }
  const title = `<b>Сайты партнёров: ${loud.length === 1 ? 'изменилась 1 страница' : `изменений — ${loud.length}`}</b>`;
  const tail = 'Наши карточки этих туров могли устареть — сверьте и поправьте.';
  let body = title;
  let shown = 0;
  for (const b of blocks) {
    if (body.length + b.length + tail.length + 80 > MESSAGE_CAP) break;
    body += `\n\n${b}`;
    shown++;
  }
  if (shown < blocks.length) body += `\n\nещё изменений: ${blocks.length - shown} — полностью в partner_page_snapshots`;
  return `${body}\n\n${tail}`;
}

function cut(line: string): string {
  return line.length > 220 ? `${line.slice(0, 219)}…` : line;
}

/** Первый прогон: кого взяли под наблюдение — одним сообщением, чтобы владелец сверил список. */
export function baselineMessage(pages: WatchedPage[]): string | null {
  if (pages.length === 0) return null;
  const byPartner = new Map<string, number>();
  for (const p of pages) byPartner.set(p.partnerName, (byPartner.get(p.partnerName) ?? 0) + 1);
  const lines = [...byPartner.entries()].map(([name, n]) => `${escapeHtml(name)} — страниц: ${n}`);
  return [
    '<b>Сайты партнёров: наблюдение начато</b>',
    '',
    ...lines,
    '',
    'Раз в сутки сверяю видимый текст этих страниц с прошлым разом и пишу сюда, если что-то поменялось.',
  ].join('\n');
}
