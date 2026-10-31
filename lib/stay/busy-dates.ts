/**
 * «Занято с 5 по 9 ноября» — занятость объекта жилья без номеров словами
 * хозяина (слово владельца 30.10: хозяин «Кутхи» «сейчас на бумажке посмотрю,
 * когда занято»; нужен очень понятный интерфейс в MAX).
 *
 * Объект без номеров (accommodation_rooms пуст) до этого дня занятости не
 * имел вовсе: календарь занятости считался от номеров, и при поиске по датам
 * такой объект выпадал из выдачи молча. Теперь занятость объекта — строки
 * accommodation_availability с room_id IS NULL и is_blocked (721): хозяин
 * пишет её фразой в чат или снимает кнопкой «Освободить», гость видит
 * занятые даты на карточке и в поиске по датам.
 *
 * Чистые функции: разбор фразы, группировка дат в отрезки, тексты. Запись и
 * чтение — в busy-flow. Даты «с 5 по 9» читаются ВКЛЮЧИТЕЛЬНО: занято и
 * 5-го, и 9-го. Это перестраховка в пользу хозяина: лишняя закрытая ночь
 * стоит одной заявки, открытая по ошибке — двойного заселения. Ответ
 * хозяину называет записанные даты и число ночей, чтобы ошибку было видно.
 *
 * Это не бронь: даты и цену по-прежнему подтверждает хозяин по телефону,
 * оплаты через платформу нет (1206).
 */
import { escapeHtml } from '@/lib/text/escape-html';
import { ruDate } from '@/lib/stay/stay-request';

export type BusyAction = 'block' | 'release';

export interface BusyCommand {
  action: BusyAction;
  /** 'YYYY-MM-DD', включительно. */
  from: string;
  to: string;
  /** Слова между «занято» и датами — название объекта, когда их несколько. null — не названо. */
  objectWords: string | null;
}

export type BusyParse =
  | { ok: true; command: BusyCommand }
  /**
   * not_busy — фраза не про занятость, отвечает помощник как раньше;
   * no_dates — «занято», а дат нет или не разобрались; order — конец раньше
   * начала; past — весь отрезок в прошлом; too_long — длиннее потолка.
   */
  | { ok: false; reason: 'not_busy' | 'no_dates' | 'order' | 'past' | 'too_long' };

/** Полгода вперёд: длиннее — не занятость, а снятие объекта с сайта. */
export const BUSY_MAX_DAYS = 180;
/** Сколько дней вперёд показывает экран «Занято» и читает карточка гостя. */
export const BUSY_HORIZON_DAYS = 180;

// `\b` в JS знает только латиницу: граница кириллического слова — просмотром вперёд.
const KEYWORD = /^(занято|занят[аы]?|свободно|освободилось|освободил[аи]?)(?![а-яё])[\s:,—-]*/i;

const MONTHS: ReadonlyArray<[RegExp, number]> = [
  [/^янв/, 1], [/^фев/, 2], [/^мар/, 3], [/^апр/, 4], [/^ма[йя]/, 5], [/^июн/, 6],
  [/^июл/, 7], [/^авг/, 8], [/^сен/, 9], [/^окт/, 10], [/^ноя/, 11], [/^дек/, 12],
];

interface DateToken { day: number; month: number | null; year: number | null; index: number; length: number }

const TOKEN = /(\d{1,2})(?:\.(\d{1,2})(?:\.(\d{2,4}))?|\s*([а-яё]{3,8})(?:\s+(\d{4}))?)?/gi;

function monthOf(word: string | undefined): number | null {
  if (!word) return null;
  const w = word.toLowerCase().replace(/ё/g, 'е');
  for (const [re, n] of MONTHS) if (re.test(w)) return n;
  return null;
}

function tokens(text: string): DateToken[] {
  const out: DateToken[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    const day = Number(m[1]);
    if (day < 1 || day > 31) continue;
    let month: number | null = null;
    let year: number | null = null;
    let length = m[1]!.length;
    if (m[2] !== undefined) {
      month = Number(m[2]);
      if (month < 1 || month > 12) continue;
      year = m[3] !== undefined ? Number(m[3]) : null;
      if (year !== null && year < 100) year += 2000;
      length = m[0].length;
    } else if (m[4] !== undefined) {
      const mon = monthOf(m[4]);
      if (mon !== null) {
        month = mon;
        year = m[5] !== undefined ? Number(m[5]) : null;
        length = m[0].length;
      }
      // Слово после числа — не месяц («5 человек»): число остаётся без месяца.
    }
    out.push({ day, month, year, index: m.index, length });
  }
  return out;
}

function ymd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // 31 февраля
  return dt.toISOString().slice(0, 10);
}

/** Ночей в отрезке включительно: с 5 по 9 — пять. */
export function nightsInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function shiftYmd(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Разбор фразы. `today` — сегодня по Камчатке ('YYYY-MM-DD'): от него год
 * без года в фразе (ближайшее будущее) и граница прошлого.
 */
export function parseBusyPhrase(text: string, today: string): BusyParse {
  const t = text.trim().replace(/ё/g, 'е');
  const kw = KEYWORD.exec(t);
  if (!kw) return { ok: false, reason: 'not_busy' };
  const action: BusyAction = /^занят/i.test(kw[1]!) ? 'block' : 'release';
  const rest = t.slice(kw[0].length);
  const all = tokens(rest);
  if (all.length === 0) return { ok: false, reason: 'no_dates' };
  const [a, b] = [all[0]!, all[1] ?? null];

  // Месяц без месяца берётся у соседа: «с 5 по 9 ноября».
  const monthB = b ? (b.month ?? a.month) : null;
  const monthA = a.month ?? monthB;
  if (monthA === null) return { ok: false, reason: 'no_dates' };
  const todayYear = Number(today.slice(0, 4));

  // Конец — ближайший в будущем (или этот год, если ещё не прошёл); начало —
  // того же года, а если вышло позже конца («с 28 декабря по 3 января») — годом раньше.
  const endTok = b ?? a;
  const endMonth = b ? monthB! : monthA;
  const givenYear = b ? (b.year ?? a.year) : a.year;
  let endYear = givenYear ?? todayYear;
  let to = ymd(endYear, endMonth, endTok.day);
  if (!to) return { ok: false, reason: 'no_dates' };
  if (givenYear === null && to < today) {
    endYear += 1;
    to = ymd(endYear, endMonth, endTok.day);
    if (!to) return { ok: false, reason: 'no_dates' };
  }
  let from: string | null;
  if (b) {
    const startYear = a.year ?? endYear;
    from = ymd(startYear, monthA, a.day);
    if (!from) return { ok: false, reason: 'no_dates' };
    // Через Новый год — начало годом раньше; «с 9 по 5 ноября» — ошибка порядка, не прошлый год.
    if (from > to && a.year === null && monthA > endMonth) from = ymd(startYear - 1, monthA, a.day);
    if (!from) return { ok: false, reason: 'no_dates' };
  } else {
    from = to;
  }
  if (from > to) return { ok: false, reason: 'order' };
  if (to < today) return { ok: false, reason: 'past' };
  // Прошедшие ночи отрезка не записываются: «занято с 28 октября по 5 ноября» 30-го — с сегодня.
  if (from < today) from = today;
  if (nightsInclusive(from, to) > BUSY_MAX_DAYS) return { ok: false, reason: 'too_long' };

  // Без lookbehind: модуль едет в браузер (форма гостя), Safari до 16.4 его не разбирает
  // (сторож client-regex-no-lookbehind). Служебные предлоги отбрасываются по словам.
  const words = rest.slice(0, a.index)
    .replace(/[:,—–-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !/^(с|со|на|по|c)$/i.test(w))
    .join(' ');
  return { ok: true, command: { action, from, to, objectWords: words.length > 0 ? words : null } };
}

export interface BusyRange { from: string; to: string }

/** Отсортированные даты → отрезки подряд идущих дней. */
export function groupRanges(dates: readonly string[]): BusyRange[] {
  const sorted = [...new Set(dates)].sort();
  const out: BusyRange[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && shiftYmd(last.to, 1) === d) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
}

export function rangeWords(r: BusyRange): string {
  return r.from === r.to ? ruDate(r.from) : `с ${ruDate(r.from)} по ${ruDate(r.to)}`;
}

function nightsWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ночь`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ночи`;
  return `${n} ночей`;
}

// ── Тексты хозяину ──────────────────────────────────────────────────────────

export const BUSY_TEXT = {
  notStay: 'Раздел «Занято» есть только у хозяина жилья.',
  failed: 'Занятость не прочиталась — это не «всё свободно». Попробуйте ещё раз.',
  saveFailed: 'Не записалось — база не ответила. Напишите ещё раз через минуту.',
  noObjects: 'За этим чатом не числится ни одного объекта жилья на сайте. Напишите администратору Ведара.',
  notYours: 'Этого объекта среди ваших нет — ничего не изменено.',
} as const;

export function busyHintText(): string {
  return [
    'Чтобы закрыть даты, напишите одним сообщением: «занято с 5 по 9 ноября» или «занято 7 ноября».',
    'Открыть обратно — «свободно с 5 по 9 ноября» или кнопкой «Освободить» в разделе «Занято».',
    'Числа — день и месяц; год можно не писать, бот возьмёт ближайший.',
  ].join('\n');
}

export function busyRejectText(reason: Exclude<BusyParse, { ok: true }>['reason']): string {
  switch (reason) {
    case 'no_dates': return `Не разобрал даты. ${busyHintText()}`;
    case 'order': return 'Конец раньше начала — проверьте даты и напишите ещё раз, например «занято с 5 по 9 ноября».';
    case 'past': return 'Эти даты уже прошли — записывать нечего.';
    case 'too_long': return `Одним сообщением — не дольше ${BUSY_MAX_DAYS} дней. Если объект закрывается надолго, напишите администратору Ведара: его снимут с сайта на это время.`;
    default: return busyHintText();
  }
}

export function busySavedText(args: { name: string; from: string; to: string; action: BusyAction }): string {
  const range = rangeWords({ from: args.from, to: args.to });
  const nights = nightsWord(nightsInclusive(args.from, args.to));
  const name = escapeHtml(args.name);
  if (args.action === 'block') {
    return `Записал: «${name}» занято ${range} (${nights}). Гости эти даты на сайте не выберут, а в поиске по этим датам объекта не будет. Ошиблись — напишите «свободно ${range}».`;
  }
  return `Записал: «${name}» свободно ${range}. Гости снова могут оставить заявку на эти даты.`;
}

export function busyManyObjectsText(names: readonly string[], action: BusyAction): string {
  const word = action === 'block' ? 'занято' : 'свободно';
  return `У вас несколько объектов: ${names.map((n) => `«${escapeHtml(n)}»`).join(', ')}. Напишите с названием, например «${word} ${escapeHtml(names[0] ?? '')} с 5 по 9 ноября».`;
}

export function busyObjectUnknownText(words: string, names: readonly string[]): string {
  return `Объекта «${escapeHtml(words)}» среди ваших нет. Ваши объекты: ${names.map((n) => `«${escapeHtml(n)}»`).join(', ')}.`;
}

// ── Экран «Занято» ──────────────────────────────────────────────────────────

export interface BusyObjectView {
  id: string;
  name: string;
  /** Занятые даты с сегодня, 'YYYY-MM-DD'. */
  dates: string[];
}

export function busyScreenLines(objects: readonly BusyObjectView[] | null, notice?: string): string[] {
  const lines: string[] = [];
  if (notice) lines.push(notice, '');
  lines.push('<b>Занято</b>');
  if (objects === null) {
    lines.push(BUSY_TEXT.failed);
    return lines;
  }
  if (objects.length === 0) {
    lines.push(BUSY_TEXT.noObjects);
    return lines;
  }
  for (const o of objects) {
    const ranges = groupRanges(o.dates);
    lines.push('', `<b>${escapeHtml(o.name)}</b>`);
    if (ranges.length === 0) lines.push('Занятых дат не записано — для гостей всё открыто.');
    else for (const r of ranges) lines.push(`• ${rangeWords(r)} (${nightsWord(nightsInclusive(r.from, r.to))})`);
  }
  lines.push('', busyHintText());
  lines.push('Это ваш календарь для гостей сайта, не бронь: кто у вас живёт на деле, знаете только вы.');
  return lines;
}

/** Фраза-кнопка: открыть раздел «Занято» (список), а не записать даты. */
export function isBusyScreenAsk(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?…]+$/g, '');
  return t === 'занято' || t === 'что занято' || t === 'занятость' || t === 'занятые даты' || t === 'когда занято';
}

/**
 * Пересечение заявки гостя с занятыми датами: ночи [checkIn, checkOut).
 * Возвращает отрезки занятого внутри заявки — для слов гостю.
 */
export function busyWithin(busyDates: readonly string[], checkIn: string, checkOut: string): BusyRange[] {
  return groupRanges(busyDates.filter((d) => d >= checkIn && d < checkOut));
}

export function guestBusyText(ranges: readonly BusyRange[]): string {
  if (ranges.length === 0) return '';
  return `Хозяин отметил эти даты занятыми: ${ranges.map(rangeWords).join('; ')}. Выберите другие даты или позвоните хозяину.`;
}
