/**
 * Туры каталога в ответе Telegram-туристу.
 *
 * Модель расписывала июль по календарю «пик сезона», а единственный тур на
 * 5 дней в каталоге шёл 25.08–30.09.2027. Цену и даты сюда кладёт запрос,
 * не текст модели. Кнопки ведут на карточку vedarai.ru.
 */

import { detectTourIntent, isSightseeingQuestion } from '@/lib/ai/booking-intent';
import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { priceFromUnit, priceFromUnitOrSay } from '@/lib/tours/price-label';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { tourPath } from '@/lib/tours/tour-url';

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
  season_start: string | null;
  season_end: string | null;
}

export interface CatalogFacts {
  note: string;
  html: string;
  inline?: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
}

export function wantsCatalogCards(text: string): boolean {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  const rental = /аренд|прокат/.test(lower) && /авто|машин|автомобил/.test(lower) && !/(?<![а-яе])тур/.test(lower);
  if (rental) return false;
  return detectTourIntent(text).detected;
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

function monthOf(value: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? month : null;
}

function seasonMonths(start: string | null, end: string | null): number[] | null {
  const a = monthOf(start);
  const b = monthOf(end);
  if (a === null || b === null) return null;
  const out: number[] = [];
  let cursor = a;
  for (let i = 0; i < 12; i += 1) {
    out.push(cursor);
    if (cursor === b) return out;
    cursor = cursor === 12 ? 1 : cursor + 1;
  }
  return out;
}

/** true — месяц вопроса внутри сезона; null — сезон не записан; false — мимо. */
export function seasonOverlaps(tour: CatalogTour, months: number[] | null): boolean | null {
  if (!months || months.length === 0) return true;
  const have = seasonMonths(tour.season_start, tour.season_end);
  if (!have) return null;
  return months.some((month) => have.includes(month));
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

/** Месяцы вопроса, в которые этот заезд не попадает. Пустая строка — попадает во все. */
function outsideMonths(tour: CatalogTour, months: number[] | null): string {
  if (!months) return '';
  const have = seasonMonths(tour.season_start, tour.season_end);
  if (!have) return '';
  const outside = months.filter((month) => !have.includes(month));
  if (outside.length === 0) return '';
  return ` В ${monthList(outside)} этого заезда нет — не расписывай его на эти месяцы, назови фактические даты.`;
}

function tourUrl(tour: CatalogTour): string {
  return `${SITE}${tourPath({ id: tour.id, slug: tour.slug })}`;
}

function endSentence(price: string): string {
  return /[.!?…]$/.test(price) ? price : `${price}.`;
}

function buttonLabel(tour: CatalogTour): string {
  const price = priceFromUnit(tour.base_price, tour.price_unit) ?? 'цена не указана';
  const raw = `${tour.title} · ${price}`;
  return raw.length <= 64 ? raw : `${raw.slice(0, 61)}…`;
}

const EMPTY: CatalogFacts = { note: '', html: '' };

/** Вопрос именно к витрине: пустой каталог надо сказать, а не промолчать. */
function insistsOnTours(text: string): boolean {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  return isSightseeingQuestion(t)
    || /подобрать тур|покажи\s+тур|какие\s+тур|(?<![а-яе])тур(ы|ов|а|е|у)?(?![а-яе])/.test(t);
}

export function catalogFacts(
  question: string,
  loaded: { ok: true; tours: CatalogTour[] } | { ok: false },
): CatalogFacts {
  if (!wantsCatalogCards(question)) return EMPTY;
  if (!loaded.ok) {
    if (!insistsOnTours(question)) return EMPTY;
    const line = 'Каталог туров сейчас не прочитан. Цены и названия туров не называй — их не из чего взять.';
    return { note: line, html: line };
  }
  const months = askedMonths(question);
  const days = askedDays(question);
  const poolTours = loaded.tours;
  const byDuration = poolTours.filter((tour) => durationMatches(tour, days));
  const source = byDuration.length > 0 ? byDuration : poolTours;
  const fitting = source.filter((tour) => seasonOverlaps(tour, months) !== false);
  const missed = source.filter((tour) => seasonOverlaps(tour, months) === false);
  const show = (fitting.length > 0 ? fitting : missed).slice(0, 3);
  if (show.length === 0) {
    if (!insistsOnTours(question)) return EMPTY;
    const line = 'В каталоге Ведара сейчас нет живого тура под этот запрос. Цену и название тура не выдумывай.';
    return { note: line, html: line };
  }

  const when = months ? `Вопрос про ${monthList(months)}.` : 'Месяц в вопросе не назван.';
  const rows = show.map((tour) => {
    const windowNote = outsideMonths(tour, months);
    return `«${tour.title}»: ${daysPhrase(tour)}, ${seasonPhrase(tour)}, ${endSentence(priceFromUnitOrSay(tour.base_price, tour.price_unit))} Карточка: ${tourUrl(tour)}.${windowNote}`;
  });
  const missedNote = fitting.length > 0 && missed.length > 0
    ? ` Есть туры той же длины вне этих месяцев (${missed.slice(0, 2).map((tour) => `«${tour.title}», ${seasonPhrase(tour)}`).join('; ')}). В программу этих месяцев их не ставь.`
    : '';
  const note = [
    'ФАКТЫ КАТАЛОГА НА ЭТОТ ВОПРОС. Цену, название и даты бери только отсюда. Чего нет в списке — не называй.',
    when,
    ...rows,
    missedNote,
  ].filter(Boolean).join('\n');

  const htmlRows = show.map((tour) => {
    const aside = outsideMonths(tour, months);
    return `<a href="${tourUrl(tour)}">${escapeHtml(tour.title)}</a> — ${escapeHtml(daysPhrase(tour))}, ${escapeHtml(seasonPhrase(tour))}, ${escapeHtml(endSentence(priceFromUnitOrSay(tour.base_price, tour.price_unit)))}${aside ? ` ${escapeHtml(aside.trim())}` : ''}`;
  });
  const html = [`<b>Из каталога Ведара</b>`, ...htmlRows].join('\n');
  const inline = {
    inline_keyboard: show.map((tour) => [{ text: buttonLabel(tour), url: tourUrl(tour) }]),
  };
  return { note, html, inline };
}

export async function loadShowcaseTours(): Promise<{ ok: true; tours: CatalogTour[] } | { ok: false }> {
  try {
    const { rows } = await pool.query<CatalogTour>(
      `SELECT ot.id, ot.slug, ot.title, ot.base_price, ot.price_unit, ot.multi_day_count,
              ot.season_start::text AS season_start, ot.season_end::text AS season_end
         FROM operator_tours ot
        WHERE ${publicTourSql('ot')}
        ORDER BY ot.multi_day_count DESC NULLS LAST, ot.base_price ASC NULLS LAST
        LIMIT 40`,
    );
    return { ok: true, tours: rows };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    console.error('[tourist-tours] каталог не прочитан', code ? `SQLSTATE ${code}` : (err instanceof Error ? err.message.slice(0, 200) : 'нет SQLSTATE'));
    return { ok: false };
  }
}
