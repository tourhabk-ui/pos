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
 * Строка, которая меняется при каждом открытии страницы и о туре ничего не
 * говорит: арифметическая капча формы («Защита от роботов: 4+4=?», Contact
 * Form 7 `wpcf7-quiz`). Отчёт 23.10 назвал «изменениями» 24 страницы
 * «Местечка Камчатка», и во всех показанных строках менялись только цифры
 * капчи — по две формы на странице, свои цифры у каждой. Признак узкий:
 * пример со знаком «=?», цена или дата так не пишутся.
 */
const VOLATILE_LINE = /\d+\s*[+\-−×*xх]\s*\d+\s*=\s*\?/i;

export function isVolatileLine(line: string): boolean {
  return VOLATILE_LINE.test(line);
}

/**
 * Счётчик мест у выезда: «Осталось 8 мест». Меняется с каждой бронью у
 * партнёра, а на наших карточках его нет — сверять не с чем. Отчёт 08.11
 * звал изменением «Осталось 4 места» → «Осталось 3 места». В снимке строка
 * остаётся, из сравнения выбрасывается.
 */
const SEAT_COUNTER_LINE = /^осталось\s+\d+\s+мест[ао]?\.?$/i;

/**
 * Текст для сравнения: без строк-капч (снимок до 23.10 мог быть записан с
 * ними) и без счётчиков мест.
 */
function comparable(text: string): string {
  return text.split('\n').filter((l) => !isVolatileLine(l) && !SEAT_COUNTER_LINE.test(l)).join('\n');
}

/**
 * Видимый текст страницы строками: без скриптов, стилей и разметки, сущности
 * развёрнуты, пробелы схлопнуты, пустые строки и строки-капчи выброшены.
 * Сравнивается именно он — смена вёрстки, счётчиков в скриптах, CDN-адресов и
 * цифр капчи изменением не считается, смена цены или даты в тексте — считается.
 */
export function pageText(html: string): string {
  const text = decodeHtmlEntities(htmlToText(html))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(Number(d)));
  const lines = text.split('\n')
    .map((l) => l.replace(/[\s ]+/g, ' ').trim())
    .filter((l) => l.length > 0 && !isVolatileLine(l));
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
 * Разница, которую стоит показать человеку. Капчи и счётчики мест выброшены
 * из обоих текстов; сдвиг скользящей даты и прошедший выезд (если передан
 * `today` — сегодня по Камчатке, YYYY-MM-DD) изменением не считаются. Если
 * после этого не пропало и не появилось ни одной строки — изменения нет,
 * null. Так молчат смена капчи, перестановка или повтор тех же строк и
 * просто наступивший день: хэш у таких текстов разный, а партнёр ничего не
 * менял.
 */
export function meaningfulDiff(prevText: string, nextText: string, today?: string): TextDiff | null {
  let d = withoutRollingShifts(diffLines(comparable(prevText), comparable(nextText)));
  if (today) d = withoutPassedDepartures(d, today);
  return d.removed.length === 0 && d.added.length === 0 ? null : d;
}

/**
 * «Скользящая» дата: строка вроде «Ближайший выезд: 4 ноября» на
 * laguna-expedition.ru сама сдвигается каждый день — партнёр ничего не
 * менял, а отчёт звал это изменением (слово владельца 03.11). Пара
 * «пропала / появилась» гасится, только если строки совпадают целиком,
 * кроме дат, и каждая дата сдвинулась ВПЕРЁД не больше чем на
 * ROLLING_MAX_DAYS. Сдвиг назад, дальний перенос, новая цена или другой
 * текст рядом с датой — по-прежнему изменение.
 */
export const ROLLING_MAX_DAYS = 14;

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const DATE_RE = new RegExp(
  String.raw`(?<![\d.])(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?(?![\d.])` +
  String.raw`|(?<!\d)(\d{1,2})\s+(январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|августа?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])(?:\s+(20\d\d))?(?![а-яё])`,
  'gi',
);

/** Дни от условной эпохи; год, если не указан, — один и тот же условный. */
function dayNumber(day: number, month: number, year: number | null): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year ?? 2000, month - 1, day) / 86_400_000;
}

function rollingKey(line: string): { mask: string; days: (number | null)[] } {
  const days: (number | null)[] = [];
  const mask = line.replace(DATE_RE, (_m, d1, m1, y1, d2, mon) => {
    if (d1) {
      const y = y1 ? Number(y1.length === 2 ? `20${y1}` : y1) : null;
      days.push(dayNumber(Number(d1), Number(m1), y));
    } else {
      const lower = String(mon).toLowerCase();
      const idx = MONTHS.findIndex((m) => lower.startsWith(m));
      days.push(dayNumber(Number(d2), idx + 1, null));
    }
    return '\u0000';
  });
  return { mask, days };
}

function isRollingShift(prev: string, next: string): boolean {
  const a = rollingKey(prev);
  const b = rollingKey(next);
  if (a.days.length === 0 || a.mask !== b.mask || a.days.length !== b.days.length) return false;
  return a.days.every((x, i) => {
    const y = b.days[i];
    if (x === null || y === null) return false;
    let delta = y - x;
    if (delta < 0) delta += 365; // декабрь → январь без года в строке
    return delta > 0 && delta <= ROLLING_MAX_DAYS;
  });
}

/** Убирает из разницы пары строк, где сдвинулась только скользящая дата. */
export function withoutRollingShifts(d: TextDiff): TextDiff {
  const added = [...d.added];
  const removed: string[] = [];
  for (const r of d.removed) {
    const i = added.findIndex((a) => isRollingShift(r, a));
    if (i >= 0) added.splice(i, 1); else removed.push(r);
  }
  return { removed, added };
}

/*
 * Прошедший выезд. Отчёт 08.11 о «Лагуне» почти целиком состоял из строк
 * «было: 08 ноября 2026,» и «было: 08 ноября 2026» — начало и конец
 * однодневного выезда в день самого выезда. Партнёр ничего не снимал: день
 * наступил, и сайт убрал выезд из календаря сам.
 *
 * Пропавшая строка гасится, только если в ней нет ничего, кроме дат С ГОДОМ
 * (и дня недели, знаков препинания), и все эти даты не позже сегодняшней по
 * Камчатке. Дата без года прошедшей не считается: «4 ноября» может значить и
 * следующий год. Пропавшая БУДУЩАЯ дата — по-прежнему изменение: это снятый
 * выезд.
 *
 * Вместе с выездом с календаря уходят строки его дня недели, времени
 * («в 10:00») и месяца («Ноябрь 2026»), если другой такой на странице не
 * осталось. Они гасятся только рядом с погашенной датой и только когда строк
 * того же рода не появилось: «в 09:00» → «в 10:00» — смена времени, её видно.
 * Заголовок месяца позже текущего не гасится: будущий месяц сам не уходит.
 */
const WEEKDAY_RE = /(?<![а-яё])(?:понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс)(?![а-яё])/gi;
const PUNCT_ONLY = /^[\s,.;:!?()«»"'—–-]*$/;
const TIME_ONLY = /^(?:в\s+)?\d{1,2}:\d{2}(?:\s*[—–-]\s*\d{1,2}:\d{2})?$/i;
const MONTH_HEADER = /^(январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь)\s+(20\d\d)$/i;
const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function isoDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Даты строки (YYYY-MM-DD у даты с годом, null — без года) и что осталось вокруг них. */
function datesOf(line: string): { days: (string | null)[]; rest: string } {
  const days: (string | null)[] = [];
  const rest = line.replace(DATE_RE, (_m, d1, m1, y1, d2, mon, y2) => {
    if (d1) {
      days.push(y1 ? isoDay(Number(y1.length === 2 ? `20${y1}` : y1), Number(m1), Number(d1)) : null);
    } else {
      const lower = String(mon).toLowerCase();
      days.push(y2 ? isoDay(Number(y2), MONTHS.findIndex((m) => lower.startsWith(m)) + 1, Number(d2)) : null);
    }
    return ' ';
  });
  return { days, rest };
}

function isPassedDateLine(line: string, today: string): boolean {
  const { days, rest } = datesOf(line);
  if (days.length === 0 || !PUNCT_ONLY.test(rest.replace(WEEKDAY_RE, ''))) return false;
  return days.every((day) => day !== null && day <= today);
}

type CalendarCompanion = 'weekday' | 'time' | 'month';

function companionKind(line: string): CalendarCompanion | null {
  if (TIME_ONLY.test(line)) return 'time';
  if (MONTH_HEADER.test(line)) return 'month';
  const bare = line.replace(WEEKDAY_RE, '');
  return bare !== line && PUNCT_ONLY.test(bare) ? 'weekday' : null;
}

function monthNotAfter(line: string, today: string): boolean {
  const m = MONTH_HEADER.exec(line);
  if (!m) return false;
  const month = MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1;
  return `${m[2]}-${String(month).padStart(2, '0')}` <= today.slice(0, 7);
}

/** Убирает из разницы прошедшие выезды и строки, ушедшие вместе с ними. */
export function withoutPassedDepartures(d: TextDiff, today: string): TextDiff {
  const removed = d.removed.filter((l) => !isPassedDateLine(l, today));
  if (removed.length === d.removed.length) return d;
  const addedKinds = new Set(d.added.map(companionKind).filter((k): k is CalendarCompanion => k !== null));
  return {
    removed: removed.filter((l) => {
      const kind = companionKind(l);
      if (kind === null || addedKinds.has(kind)) return true;
      return kind === 'month' && !monthNotAfter(l, today);
    }),
    added: d.added,
  };
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
  /**
   * Сайт ведёт платформа (`partners.site_managed_by_platform`, 1312). Тогда
   * изменение — наша правка или правка того, у кого остался доступ, и правда —
   * наши карточки, а не сайт. Нет поля — сайт не наш.
   */
  managedByUs?: boolean;
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

/** Больше сообщений за прогон не шлём: остаток назван числом. */
const MAX_MESSAGES = 5;

/**
 * Сообщения владельцу. Пусто — сообщать нечего: точки отсчёта, «без перемен»
 * и молчащие исходы в Telegram не идут. Текст — HTML для parse_mode, всё
 * чужое экранировано: строки с сайта партнёра — не наша разметка.
 *
 * Не влезло в одно сообщение — идёт следующим, до MAX_MESSAGES. Отчёт 08.11
 * кончался строкой «ещё изменений: 14 — полностью в partner_page_snapshots»:
 * таблицу базы владелец не читает, и 14 изменений он не увидел вовсе.
 */
export function ownerMessages(reports: PageReport[]): string[] {
  const loud = reports.filter((r) => r.event === 'changed' || r.event === 'gone' || r.event === 'back' || r.event === 'failing');
  if (loud.length === 0) return [];
  const blocks: string[] = [];
  for (const r of loud) {
    const head = `<b>${escapeHtml(r.page.partnerName)}</b>${r.page.managedByUs ? ' (сайт ведём мы)' : ''} — ${escapeHtml(what(r.page))}`;
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
  // Направление сверки зависит от того, чей сайт: чужой поменялся — устарели
  // наши карточки; наш поменялся — сайт сверяется с карточками.
  const tail = [
    loud.some((r) => !r.page.managedByUs) ? 'Наши карточки этих туров могли устареть — сверьте и поправьте.' : null,
    loud.some((r) => r.page.managedByUs)
      ? 'Сайт с пометкой «ведём мы» правим мы сами: если правка не наша — проверьте, у кого есть доступ. Правда там — наши карточки, сайт сверяется с ними.'
      : null,
  ].filter(Boolean).join('\n');
  const messages: string[] = [];
  let body = title;
  let inBody = 0;
  let shown = 0;
  for (const b of blocks) {
    if (inBody > 0 && body.length + b.length + tail.length + 160 > MESSAGE_CAP) {
      if (messages.length + 1 >= MAX_MESSAGES) break;
      messages.push(body);
      body = '<b>Сайты партнёров — продолжение</b>';
      inBody = 0;
    }
    body += `\n\n${b}`;
    inBody++;
    shown++;
  }
  if (shown < blocks.length) {
    body += `\n\nещё изменений: ${blocks.length - shown} — не вошли в ${MAX_MESSAGES} сообщений; они записаны в журнале наблюдения на сервере`;
  }
  messages.push(`${body}\n\n${tail}`);
  return messages;
}

function cut(line: string): string {
  return line.length > 220 ? `${line.slice(0, 219)}…` : line;
}

/** Первый прогон: кого взяли под наблюдение — одним сообщением, чтобы владелец сверил список. */
export function baselineMessage(pages: WatchedPage[]): string | null {
  if (pages.length === 0) return null;
  const byPartner = new Map<string, { n: number; ours: boolean }>();
  for (const p of pages) {
    const was = byPartner.get(p.partnerName) ?? { n: 0, ours: false };
    byPartner.set(p.partnerName, { n: was.n + 1, ours: was.ours || p.managedByUs === true });
  }
  const lines = [...byPartner.entries()].map(([name, { n, ours }]) =>
    `${escapeHtml(name)} — страниц: ${n}${ours ? ' · сайт ведём мы' : ''}`);
  return [
    '<b>Сайты партнёров: наблюдение начато</b>',
    '',
    ...lines,
    '',
    'Раз в сутки сверяю видимый текст этих страниц с прошлым разом и пишу сюда, если что-то поменялось.',
  ].join('\n');
}
