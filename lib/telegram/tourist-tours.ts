/**
 * Туры каталога в ответе Telegram-туристу.
 *
 * Модель расписывала июль по календарю «пик сезона», а единственный тур на
 * 5 дней в каталоге шёл 25.08–30.09.2027. Цену и даты сюда кладёт запрос,
 * не текст модели. Кнопки ведут на карточку vedarai.ru.
 */

import { askedActivity, isSightseeingQuestion, wantsTourCards } from '@/lib/ai/booking-intent';
import { namedVolcanoes, volcanoNamePatterns } from '@/lib/ai/tour-place-relevance';
import { pool } from '@/lib/db-pool';
import { calendarDay, coversDay, lastDay, overlapsWindow, parseIsoDate, windowForMonths, ymd, type DateWindow } from '@/lib/kuzmich/season-window';
import { rentalHiddenOnSite } from '@/lib/rental/site-pause';
import { escapeHtml } from '@/lib/text/escape-html';
import { priceFromUnit, priceFromUnitOrSay } from '@/lib/tours/price-label';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { tourPath } from '@/lib/tours/tour-url';

/** Сколько туров называем вместе с карточкой. Остальные — числом, без имён и цен. */
export const NAMED_TOUR_CAP = 8;

const SITE = 'https://vedarai.ru';

const MONTH_WORD: Array<[RegExp, number]> = [
  [/(?<![а-яе])январ/, 1],
  [/(?<![а-яе])феврал/, 2],
  [/(?<![а-яе])март(?![а-яе])/, 3],
  [/(?<![а-яе])апрел/, 4],
  [/(?<![а-яе])ма[йея](?![а-яе])/, 5],
  [/(?<![а-яе])июн/, 6],
  [/(?<![а-яе])июл/, 7],
  [/(?<![а-яе])август/, 8],
  [/(?<![а-яе])сентябр/, 9],
  [/(?<![а-яе])октябр/, 10],
  [/(?<![а-яе])ноябр/, 11],
  [/(?<![а-яе])декабр/, 12],
];

const MONTH_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const MONTH_PREP = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
];

export interface CatalogTour {
  id: number;
  slug: string | null;
  title: string;
  base_price: number | string | null;
  price_unit: string | null;
  multi_day_count: number | null;
  activity_type?: string | null;
  location_name?: string | null;
  description?: string | null;
  /**
   * Текст, по которому запрос витрины искал место: название, место и
   * описание целиком. `description` в выборке обрезан до 400 знаков, и вулкан,
   * названный дальше, отбор в коде терял (находка 24.10).
   */
  match_text?: string | null;
  season_start: string | null;
  season_end: string | null;
  /** partners.slug. Пауза проката прячет этого партнёра из источников ответа. */
  operator_slug?: string | null;
  operator_name?: string | null;
}

export interface CatalogFacts {
  note: string;
  html: string;
  inline?: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
}

/** Названный месяц важнее «летом»: «в июле летом» — это июль. */
export function askedMonths(text: string): number[] | null {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  const named: number[] = [];
  for (const [rx, month] of MONTH_WORD) {
    if (rx.test(t) && !named.includes(month)) named.push(month);
  }
  if (named.length > 0) return named;
  if (/летом/.test(t)) return [6, 7, 8];
  if (/зимой/.test(t)) return [12, 1, 2];
  if (/осенью/.test(t)) return [9, 10, 11];
  if (/весной/.test(t)) return [3, 4, 5];
  return null;
}

export function askedDays(text: string): number | null {
  const m = /(\d{1,2})\s*дн/.exec(text.toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 30 ? n : null;
}

function yearMonthOf(value: string | null): { y: number; m: number } | null {
  const iso = parseIsoDate(value);
  if (!iso) return null;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return m >= 1 && m <= 12 ? { y, m } : null;
}

/**
 * Месяцы сезона по настоящим датам, с годом. Сезон 1 октября 2026 —
 * 31 октября 2027 — все двенадцать: прежний обход от месяца начала до первого
 * месяца конца без года давал один октябрь, и на июль туристу уходило ложное
 * «В июле этого заезда нет» (находка 24.10). Конец раньше начала — null.
 */
function seasonMonths(start: string | null, end: string | null): number[] | null {
  const a = yearMonthOf(start);
  const b = yearMonthOf(end);
  if (a === null || b === null) return null;
  const last = b.y * 12 + b.m;
  let cursor = a.y * 12 + a.m;
  if (cursor > last) return null;
  const out: number[] = [];
  while (cursor <= last && out.length < 12) {
    out.push(((cursor - 1) % 12) + 1);
    cursor += 1;
  }
  return out;
}

/**
 * Месяц вопроса есть среди месяцев сезона, без года.
 * Доступность этим больше не решается: год режет `questionWindow`.
 * Функция остаётся для сверки «июль не входит в август–сентябрь».
 */
export function seasonOverlaps(tour: CatalogTour, months: number[] | null): boolean | null {
  if (!months || months.length === 0) return true;
  const have = seasonMonths(tour.season_start, tour.season_end);
  if (!have) return null;
  return months.some((month) => have.includes(month));
}

/**
 * Окно названного сезона или месяца. Нет сезона в вопросе — null (тогда судит «сегодня»).
 * Если сегодня уже внутри этого окна, начало сдвигается на сегодня: заезд,
 * который кончился в сентябре, 25 октября «осенью» доступным не называется.
 */
export function questionWindow(question: string, now: Date = new Date()): DateWindow | null {
  const months = askedMonths(question);
  if (!months) return null;
  const window = windowForMonths(months, calendarDay(now));
  const today = calendarDay(now).iso;
  if (today > window.start && today <= window.end) {
    return { ...window, start: today };
  }
  return window;
}

export function ruDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const month = MONTH_GENITIVE[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

function seasonPhrase(tour: CatalogTour): string {
  const start = ruDate(tour.season_start);
  const end = ruDate(tour.season_end);
  if (start && end) return `сезон ${start} — ${end}`;
  return 'сезон в каталоге не записан';
}

function daysPhrase(tour: CatalogTour): string {
  return tour.multi_day_count ? `${tour.multi_day_count} дн.` : 'длительность не записана';
}

function durationMatches(tour: CatalogTour, days: number | null): boolean {
  if (days === null || tour.multi_day_count == null) return true;
  return Math.abs(tour.multi_day_count - days) <= 1;
}

function monthList(months: number[]): string {
  return months.map((m) => MONTH_PREP[m - 1] ?? String(m)).join(', ');
}

/**
 * Дни месяца внутри окна вопроса, с годом окна. Месяц, который в этом окне
 * уже прошёл (окно начато сегодняшним днём), — null: о нём не говорим.
 */
function monthInWindow(month: number, window: DateWindow): DateWindow | null {
  const first = Number(window.start.slice(0, 4));
  const last = Number(window.end.slice(0, 4));
  for (let y = first; y <= last; y += 1) {
    const from = ymd(y, month, 1);
    const to = ymd(y, month, lastDay(y, month));
    const start = from > window.start ? from : window.start;
    const end = to < window.end ? to : window.end;
    if (start <= end) return { start, end, label: window.label };
  }
  return null;
}

/**
 * Месяцы вопроса, в которые этот заезд не попадает — по датам окна вопроса,
 * с годом: «июль» осенью 2026 — это июль 2027, и сезон до октября 2027 его
 * накрывает. Сезон без дат — ничего не утверждаем.
 */
function missedMonths(tour: CatalogTour, months: number[] | null, window: DateWindow | null): number[] {
  if (!months || !window) return [];
  if (!parseIsoDate(tour.season_start) || !parseIsoDate(tour.season_end)) return [];
  return months.filter((month) => {
    const span = monthInWindow(month, window);
    if (!span) return false;
    return !overlapsWindow(tour.season_start, tour.season_end, span);
  });
}

/** Модели: не расписывать заезд на месяц, которого в сезоне нет. */
function modelWindow(outside: number[]): string {
  if (outside.length === 0) return '';
  return ` В ${monthList(outside)} этого заезда нет — не расписывай его на эти месяцы, назови фактические даты.`;
}

/** Туристу: факт, без указания модели. */
function humanWindow(outside: number[]): string {
  if (outside.length === 0) return '';
  return `В ${monthList(outside)} этого заезда нет.`;
}

/**
 * Цена на карточке туристу. Предупреждение «не называй ценой с человека»
 * остаётся в записке модели, в сообщение его не кладём.
 */
function touristPrice(tour: CatalogTour): string {
  const labeled = priceFromUnit(tour.base_price, tour.price_unit);
  if (!labeled) return 'цена не указана';
  return labeled.replace(
    ' (за что назначена цена — не записано, не называй её ценой с человека)',
    ' (за что назначена цена — не записано)',
  );
}

const SHOWCASE_LIMIT = 40;

/**
 * Чем сужать каталог.
 *
 * Названный вулкан — место, не тип: джип и вертолёт к нему остаются,
 * восхождение на другой вулкан с типом volcano — нет (урок 13.10).
 * «Что посмотреть у реки» — не запрос только сплава: слово «река» в таком
 * вопросе вид занятия не назначает.
 */
export function showcaseLookup(question: string):
  | { kind: 'general' }
  | { kind: 'volcano'; patterns: string[] }
  | { kind: 'activity'; type: string; word: string } {
  const volcanoes = namedVolcanoes(question);
  if (volcanoes.length > 0) {
    const patterns = volcanoNamePatterns(volcanoes);
    if (patterns.length > 0) return { kind: 'volcano', patterns };
  }
  if (isSightseeingQuestion(question)) return { kind: 'general' };
  const hint = askedActivity(question);
  if (!hint.word || !hint.type) return { kind: 'general' };
  return { kind: 'activity', type: hint.type, word: hint.word.replace(/ё/g, 'е') };
}

/** Тот же текст, что искал запрос витрины; без него — то, что есть в строке. */
function tourText(tour: CatalogTour): string {
  if (tour.match_text) return tour.match_text;
  return [tour.title, tour.location_name ?? '', tour.description ?? ''].join(' ');
}

function selectTours(question: string, tours: CatalogTour[]): CatalogTour[] {
  const lookup = showcaseLookup(question);
  if (lookup.kind === 'volcano') {
    const asked = namedVolcanoes(question);
    return tours.filter((tour) => namedVolcanoes(tourText(tour)).some((name) => asked.includes(name)));
  }
  if (lookup.kind === 'activity') {
    return tours.filter((tour) => {
      const title = tour.title.toLowerCase().replace(/ё/g, 'е');
      return tour.activity_type === lookup.type || title.includes(lookup.word);
    });
  }
  return tours;
}

function tourUrl(tour: CatalogTour): string {
  return `${SITE}${tourPath({ id: tour.id, slug: tour.slug })}`;
}

function endSentence(price: string): string {
  return /[.!?…]$/.test(price) ? price : `${price}.`;
}

const BUTTON_MAX = 64;

/**
 * Подпись кнопки читает человек: цена — как в карточке, без указания модели
 * (прежде на кнопку уходил обрубок «…не называй её ценой с че…», находка 24.10).
 * Не влезает — укорачивается название, а не цена: обрывок фразы про цену
 * хуже короткого названия, карточка по кнопке назовёт его целиком.
 */
function buttonLabel(tour: CatalogTour): string {
  const price = touristPrice(tour).replace(' (за что назначена цена — не записано)', ', за что — не записано');
  const room = BUTTON_MAX - price.length - 3;
  const title = tour.title.length <= room
    ? tour.title
    : `${tour.title.slice(0, Math.max(room - 1, 1)).trimEnd()}…`;
  const raw = `${title} · ${price}`;
  return raw.length <= BUTTON_MAX ? raw : `${raw.slice(0, BUTTON_MAX - 1)}…`;
}

const EMPTY: CatalogFacts = { note: '', html: '' };

export interface PickedTours {
  kind: 'not_tour' | 'unread' | 'none' | 'list';
  /** Что сказать, когда списка нет. */
  line: string;
  tours: CatalogTour[];
  unnamedMore: number;
  window: DateWindow | null;
  /** Подпись окна или «сегодня, …». */
  windowLabel: string | null;
}

function onSite(tour: CatalogTour, now: Date): boolean {
  if (!tour.operator_slug) return true;
  return !rentalHiddenOnSite(tour.operator_slug, now);
}

/**
 * Туры, которые можно назвать доступными на этот вопрос.
 * Сезон без пересечения с окном (или с сегодняшним днём) в список не входит.
 * Партнёр на паузе проката из источников убран.
 */
export function pickToursForAnswer(
  question: string,
  loaded: { ok: true; tours: CatalogTour[]; complete?: boolean } | { ok: false },
  now: Date = new Date(),
): PickedTours {
  const empty: PickedTours = { kind: 'not_tour', line: '', tours: [], unnamedMore: 0, window: null, windowLabel: null };
  if (!wantsTourCards(question)) return empty;
  if (!loaded.ok) {
    if (!insistsOnTours(question)) return empty;
    return {
      ...empty,
      kind: 'unread',
      line: 'Каталог туров сейчас не прочитан. Цены и названия туров не называю — их не из чего взять.',
    };
  }
  const window = questionWindow(question, now);
  const today = calendarDay(now);
  const lookup = showcaseLookup(question);
  const matched = selectTours(question, loaded.tours).filter((tour) => onSite(tour, now));
  const sawAll = loaded.complete !== false && (lookup.kind !== 'general' || loaded.tours.length < SHOWCASE_LIMIT);
  if (lookup.kind !== 'general' && matched.length === 0 && loaded.tours.length > 0) {
    if (!sawAll) return empty;
    const line = lookup.kind === 'volcano'
      ? 'В каталоге Ведара нет живого тура к этому вулкану. Тур к другому вулкану вместо него не называю и цену не выдумываю.'
      : 'В каталоге Ведара нет живого тура этого вида. Чужой тур вместо него не называю и цену не выдумываю.';
    return { ...empty, kind: 'none', line };
  }
  const poolTours = matched;
  const days = askedDays(question);
  const byDuration = poolTours.filter((tour) => durationMatches(tour, days));
  const source = byDuration.length > 0 ? byDuration : poolTours;
  const running = source.filter((tour) => (
    window
      ? overlapsWindow(tour.season_start, tour.season_end, window)
      : coversDay(tour.season_start, tour.season_end, today.iso)
  ));
  const windowLabel = window?.label ?? `сегодня, ${ruDate(today.iso) ?? today.iso}`;
  if (running.length === 0) {
    if (!insistsOnTours(question) && lookup.kind === 'general' && !window) return empty;
    const when = window
      ? `На ${window.label} (${ruDate(window.start) ?? window.start} — ${ruDate(window.end) ?? window.end}) в каталоге нет тура, который идёт.`
      : `На сегодня (${ruDate(today.iso) ?? today.iso}) в каталоге нет тура, который идёт.`;
    return {
      ...empty,
      kind: 'none',
      line: `${when} Заезд другого года доступным не называю. Цену не называю.`,
      window,
      windowLabel,
    };
  }
  const tours = running.slice(0, NAMED_TOUR_CAP);
  return {
    kind: 'list',
    line: '',
    tours,
    unnamedMore: running.length - tours.length,
    window,
    windowLabel,
  };
}

/** Вопрос именно к витрине: пустой каталог надо сказать, а не промолчать. */
function insistsOnTours(text: string): boolean {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  return isSightseeingQuestion(t)
    || /подобрать тур|покажи\s+тур|какие\s+тур|(?<![а-яе])тур(ы|ов|а|е|у)?(?![а-яе])/.test(t);
}

export function catalogFacts(
  question: string,
  loaded: { ok: true; tours: CatalogTour[]; complete?: boolean } | { ok: false },
  now: Date = new Date(),
): CatalogFacts {
  const picked = pickToursForAnswer(question, loaded, now);
  if (picked.kind === 'not_tour') return EMPTY;
  if (picked.kind !== 'list') return { note: picked.line, html: picked.line };
  const show = picked.tours;
  const months = picked.window ? askedMonths(question) : null;
  const window = picked.window;
  const when = picked.windowLabel
    ? `Вопрос про ${picked.windowLabel}.`
    : 'Месяц в вопросе не назван. Называю только туры, чей сезон идёт сегодня.';
  const rows = show.map((tour) => {
    const windowNote = modelWindow(missedMonths(tour, months, window));
    return `«${tour.title}»: ${daysPhrase(tour)}, ${seasonPhrase(tour)}, ${endSentence(priceFromUnitOrSay(tour.base_price, tour.price_unit))} Карточка: ${tourUrl(tour)}.${windowNote}`;
  });
  const more = picked.unnamedMore > 0
    ? `Ещё ${picked.unnamedMore} на эти даты в каталоге. Названия и цены здесь не повторяю.`
    : '';
  const note = [
    'ФАКТЫ КАТАЛОГА НА ЭТОТ ВОПРОС. Цену, название и даты бери только отсюда. Чего нет в списке — не называй. Заезд вне этого окна доступным не называй.',
    when,
    ...rows,
    more,
  ].filter(Boolean).join('\n');

  const htmlRows = show.map((tour) => {
    const aside = humanWindow(missedMonths(tour, months, window));
    return `<a href="${tourUrl(tour)}">${escapeHtml(tour.title)}</a> — ${escapeHtml(daysPhrase(tour))}, ${escapeHtml(seasonPhrase(tour))}, ${escapeHtml(endSentence(touristPrice(tour)))}${aside ? ` ${escapeHtml(aside)}` : ''}`;
  });
  const html = [`<b>Из каталога Ведара</b>`, ...htmlRows].join('\n');
  const inline = {
    inline_keyboard: show.map((tour) => [{ text: buttonLabel(tour), url: tourUrl(tour) }]),
  };
  return { note, html, inline };
}

const SHOWCASE_SELECT = `SELECT ot.id, ot.slug, ot.title, ot.base_price, ot.price_unit, ot.multi_day_count,
              ot.activity_type, ot.location_name, LEFT(ot.description, 400) AS description,
              concat_ws(' ', ot.title, ot.location_name, coalesce(ot.description, '')) AS match_text,
              ot.season_start::text AS season_start, ot.season_end::text AS season_end,
              p.slug AS operator_slug, p.name AS operator_name
         FROM operator_tours ot
         JOIN partners p ON p.id = ot.operator_id
        WHERE ${publicTourSql('ot')}`;

/** Запрос витрины: место и вид ищутся по всему каталогу, не по 40 самым длинным. */
export function showcaseQuery(question: string): { sql: string; params: unknown[] } {
  const order = 'ORDER BY ot.multi_day_count DESC NULLS LAST, ot.base_price ASC NULLS LAST';
  const lookup = showcaseLookup(question);
  if (lookup.kind === 'volcano') {
    return {
      sql: `${SHOWCASE_SELECT}
          AND translate(concat_ws(' ', ot.title, ot.location_name, coalesce(ot.description, '')), 'Ёё', 'Ее') ILIKE ANY($1::text[])
        ${order}
        LIMIT ${SHOWCASE_LIMIT}`,
      params: [lookup.patterns],
    };
  }
  if (lookup.kind === 'activity') {
    return {
      sql: `${SHOWCASE_SELECT}
          AND (ot.activity_type = $1 OR translate(ot.title, 'Ёё', 'Ее') ILIKE $2)
        ${order}
        LIMIT ${SHOWCASE_LIMIT}`,
      params: [lookup.type, `%${lookup.word}%`],
    };
  }
  return {
    sql: `${SHOWCASE_SELECT}
        ${order}
        LIMIT ${SHOWCASE_LIMIT}`,
    params: [],
  };
}

export async function loadShowcaseTours(question = ''): Promise<{ ok: true; tours: CatalogTour[]; complete: boolean } | { ok: false }> {
  try {
    const { sql, params } = showcaseQuery(question);
    const { rows } = await pool.query<CatalogTour>(sql, params);
    return { ok: true, tours: rows, complete: rows.length < SHOWCASE_LIMIT };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    console.error('[tourist-tours] каталог не прочитан', code ? `SQLSTATE ${code}` : (err instanceof Error ? err.message.slice(0, 200) : 'нет SQLSTATE'));
    return { ok: false };
  }
}
