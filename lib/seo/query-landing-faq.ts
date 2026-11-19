/**
 * Вопросы посадочной, ответ на которые — сами туры страницы (разбор видимости
 * Ведара в ответах ИИ, 19.11).
 *
 * Ответы Google на «сколько стоит» и «когда ехать» называют числа: «97–105
 * тыс. ₽, июль–октябрь». FAQ посадочных Ведара отвечал на эти вопросы
 * отсылкой — «сезон каждого тура оператор записывает в его карточке». Здесь
 * ответ собирается из тех же туров, что показаны списком: цены с единицей и
 * месяцы сезонов, записанные операторами. Чего у тура не записано, то
 * называется вслух («у 2 туров сезон не записан»), а не опускается.
 *
 * Туров нет или база не ответила — этих вопросов нет: ответа на них из базы
 * тогда тоже нет, а выдумывать его нельзя (§4.0).
 */
import type { LandingFaq, QueryLanding } from '@/lib/seo/query-landings';
import type { LandingTourRow } from '@/lib/seo/query-landings-data';
import { plural } from '@/lib/home/data-freshness';

const RU_MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthOf(v: string | null | undefined): number | null {
  const m = v ? /^\d{4}-(\d{2})-\d{2}/.exec(v) : null;
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 12 ? n : null;
}

/** Месяцы сезона тура, 1–12; сезон через Новый год (дек–мар) — по кругу. Не записан — null. */
export function seasonMonths(t: Pick<LandingTourRow, 'season_start' | 'season_end'>): number[] | null {
  const a = monthOf(t.season_start);
  const b = monthOf(t.season_end);
  if (!a || !b) return null;
  const out: number[] = [];
  for (let m = a; ; m = (m % 12) + 1) {
    out.push(m);
    if (m === b || out.length === 12) break;
  }
  return out;
}

/**
 * Месяцы словами отрезками: [6,7,8,9,10] — «июнь–октябрь»; [12,1,2,3,7] —
 * «декабрь–март, июль». Отрезок через Новый год склеивается.
 */
export function monthsWords(months: readonly number[], lang: 'ru' | 'en'): string {
  const names = lang === 'ru' ? RU_MONTHS : EN_MONTHS;
  const set = new Set(months);
  if (set.size === 12) return lang === 'ru' ? 'круглый год' : 'all year round';
  // Начало отрезка — месяц, перед которым по кругу месяца нет.
  const starts = [...set].filter((m) => !set.has(m === 1 ? 12 : m - 1)).sort((x, y) => x - y);
  const runs = starts.map((s) => {
    let e = s;
    while (set.has((e % 12) + 1)) e = (e % 12) + 1;
    return s === e ? names[s - 1]! : `${names[s - 1]}–${names[e - 1]}`;
  });
  return runs.join(', ');
}

function rub(n: number, lang: 'ru' | 'en'): string {
  return lang === 'ru' ? `${n.toLocaleString('ru-RU')} ₽` : `${n.toLocaleString('en-US')} RUB`;
}

interface Range { min: number; max: number; n: number }

type PriceRow = Pick<LandingTourRow, 'base_price' | 'price_unit'>;
type SeasonRow = Pick<LandingTourRow, 'season_start' | 'season_end'>;

function priceRange(tours: readonly PriceRow[], unit: string): Range | null {
  const ps = tours
    .filter((t) => t.price_unit === unit)
    .map((t) => Number(t.base_price))
    .filter((n) => Number.isFinite(n) && n > 0);
  return ps.length ? { min: Math.min(...ps), max: Math.max(...ps), n: ps.length } : null;
}

function rangeWords(r: Range, unitWords: string, lang: 'ru' | 'en'): string {
  const span = r.min === r.max
    ? rub(r.min, lang)
    : lang === 'ru' ? `от ${rub(r.min, 'ru')} до ${rub(r.max, 'ru')}` : `${rub(r.min, 'en')} to ${rub(r.max, 'en')}`;
  const count = lang === 'ru' ? `${r.n} ${plural(r.n, 'тур', 'тура', 'туров')}` : `${r.n} ${r.n === 1 ? 'tour' : 'tours'}`;
  return `${span} ${unitWords} (${count})`;
}

/**
 * Цены туров словами: «от 45 000 ₽ до 120 000 ₽ за человека (2 тура); 300 000 ₽
 * за группу (1 тур)». Единицы не смешиваются; нет ни одной цены с понятной
 * единицей — null. `rest` — сколько туров с ценой иначе или без неё.
 */
export function priceRangesWords(tours: readonly PriceRow[], lang: 'ru' | 'en'): { text: string; rest: number } | null {
  const ru = lang === 'ru';
  const person = priceRange(tours, 'per_person');
  const group = priceRange(tours, 'per_tour');
  const parts = [
    person && rangeWords(person, ru ? 'за человека' : 'per person', lang),
    group && rangeWords(group, ru ? 'за группу' : 'per group', lang),
  ].filter((x): x is string => Boolean(x));
  if (!parts.length) return null;
  return { text: parts.join('; '), rest: tours.length - (person?.n ?? 0) - (group?.n ?? 0) };
}

/** Месяцы сезонов туров и сколько туров без записанного сезона. */
export function seasonCover(tours: readonly SeasonRow[]): { months: Map<number, number>; unknown: number } {
  const months = new Map<number, number>();
  let unknown = 0;
  for (const t of tours) {
    const ms = seasonMonths(t);
    if (ms) ms.forEach((m) => months.set(m, (months.get(m) ?? 0) + 1)); else unknown += 1;
  }
  return { months, unknown };
}

const RU_MONTH_NAMES = RU_MONTHS;
/** Месяц(ы) с наибольшим числом туров: «август (12 туров)»; нет сезонов — null. */
export function busiestMonthsWords(months: ReadonlyMap<number, number>): string | null {
  if (!months.size) return null;
  const top = Math.max(...months.values());
  const names = [...months.entries()].filter(([, n]) => n === top).map(([m]) => m).sort((a, b) => a - b).map((m) => RU_MONTH_NAMES[m - 1]!);
  return `${names.join(', ')} (${top} ${plural(top, 'тур', 'тура', 'туров')})`;
}

function priceFaq(l: QueryLanding, tours: readonly LandingTourRow[]): LandingFaq {
  const ru = l.lang === 'ru';
  const lang = ru ? 'ru' : 'en';
  const person = priceRange(tours, 'per_person');
  const group = priceRange(tours, 'per_tour');
  const parts = [
    person && rangeWords(person, ru ? 'за человека' : 'per person', lang),
    group && rangeWords(group, ru ? 'за группу' : 'per group', lang),
  ].filter((x): x is string => Boolean(x));
  const priced = (person?.n ?? 0) + (group?.n ?? 0);
  const rest = tours.length - priced;
  if (ru) {
    const head = parts.length
      ? `По турам на этой странице — ${parts.join('; ')}. Это цены, которые операторы указали на Ведаре; итог называет оператор при подтверждении заявки.`
      : 'У туров на этой странице цена с понятной единицей не записана — её называет оператор в ответ на заявку.';
    const tail = parts.length && rest > 0 ? ` У ${rest} ${plural(rest, 'тура', 'туров', 'туров')} цена записана иначе или не записана — она в карточке тура.` : '';
    return { q: `Сколько стоят туры ${l.subject}?`, a: head + tail };
  }
  const head = parts.length
    ? `Tours on this page: ${parts.join('; ')}. These are the prices operators entered on Vedar; the final price is confirmed by the operator.`
    : 'No tour on this page has a price with a known basis; the operator quotes it in reply to a request.';
  const tail = parts.length && rest > 0 ? ` ${rest} more ${rest === 1 ? 'tour has' : 'tours have'} the price recorded differently or not at all — see the tour card.` : '';
  return { q: `How much do tours ${l.subject} cost?`, a: head + tail };
}

function seasonFaq(l: QueryLanding, tours: readonly LandingTourRow[], nearest: string | null): LandingFaq {
  const ru = l.lang === 'ru';
  const months = new Set<number>();
  let unknown = 0;
  for (const t of tours) {
    const ms = seasonMonths(t);
    if (ms) ms.forEach((m) => months.add(m)); else unknown += 1;
  }
  const said = months.size ? monthsWords([...months], ru ? 'ru' : 'en') : null;
  const d = nearest ? (ru ? nearest.split('-').reverse().join('.') : nearest) : null;
  if (ru) {
    const parts = [
      said ? `По данным операторов туры на этой странице идут: ${said}.` : 'Сезон у туров на этой странице не записан.',
      d ? `Ближайшая свободная дата — ${d}.` : 'Свободных дат в расписании сейчас нет: даты — по заявке.',
      said && unknown > 0 ? `У ${unknown} ${plural(unknown, 'тура', 'туров', 'туров')} сезон не записан.` : '',
    ].filter(Boolean);
    return { q: `Когда идут туры ${l.subject}?`, a: parts.join(' ') };
  }
  const parts = [
    said ? `According to operators, tours on this page run: ${said}.` : 'No season is recorded for tours on this page.',
    d ? `Next open date: ${d}.` : 'No open dates in the schedule now: dates on request.',
    said && unknown > 0 ? `${unknown} ${unknown === 1 ? 'tour has' : 'tours have'} no season recorded.` : '',
  ].filter(Boolean);
  return { q: `When do tours ${l.subject} run?`, a: parts.join(' ') };
}

/**
 * FAQ страницы: сначала вопросы, на которые отвечают туры («сколько стоит»,
 * «когда»), потом постоянные. Китайские страницы, трансфер, пустой или не
 * прочитанный список — только постоянные.
 */
export function landingFaq(l: QueryLanding, tours: readonly LandingTourRow[] | null, nearest: string | null): LandingFaq[] {
  if (!tours || tours.length === 0 || !l.subject || l.lang === 'zh-CN') return l.faq;
  return [priceFaq(l, tours), seasonFaq(l, tours, nearest), ...l.faq];
}
