/**
 * Тур для формы брони в веб-чате — тем же резолвером, что у мессенджеров
 * (lib/kuzmich/core.ts: chooseSellerForBooking → chooseTourForBooking).
 * До 01.11 веб-чат брал tourSuggestions[0] — первое совпадение по слову, и
 * форма открывалась на туре другой компании, если в реплике назван продавец
 * или подходящих туров несколько. Теперь: один тур — форма на нём; несколько —
 * формы нет, человек выбирает карточку сам; отказ базы — не угадываем.
 */
import { bookingWordsQuery, extractTourKeywords } from '@/lib/kuzmich/core';
import {
  resolveSellerInText,
  resolveTourChoice,
  type TourCandidate,
  type TourChoice,
} from '@/lib/kuzmich/tour-availability-tool';
import type { TourSuggestion } from '@/lib/ai/booking-intent';

export interface ChatBookingPick {
  /** Тур формы брони; null — однозначного тура нет. */
  tour: TourSuggestion | null;
  /** Туры на выбор, когда однозначного нет (для карточек). */
  candidates: TourSuggestion[];
}

export function candidateToSuggestion(c: TourCandidate): TourSuggestion {
  return {
    id: c.id,
    slug: c.slug ?? null,
    title: c.title,
    description: null,
    base_price: c.base_price == null ? 0 : Number(c.base_price),
    price_unit: c.price_unit,
    multi_day_count: c.multi_day_count ?? null,
    duration_hours: c.duration_hours ?? null,
    activity_type: null,
    location_type: null,
    location: c.place?.name ?? null,
    tour_image: null,
    operator_name: c.operator_name ?? '',
    operator_slug: null,
    operator_public: null,
    nearest_free_date: c.nearest_free_date,
  };
}

function choiceTours(choice: TourChoice): TourCandidate[] {
  switch (choice.kind) {
    case 'one': return [choice.tour];
    case 'ambiguous':
    case 'weak': return choice.candidates;
    case 'seller': return choice.tours;
    default: return [];
  }
}

export async function pickChatBookingTour(
  rawMessage: string,
  suggestions: TourSuggestion[],
): Promise<ChatBookingPick> {
  let choice: TourChoice | null;
  try {
    choice = await resolveSellerInText(rawMessage);
    if (!choice) {
      // Слова реплики раньше ключа вида: «зимняя рыбалка ноябрь январь» — тур 36.
      const words = bookingWordsQuery(rawMessage);
      const byWords = words ? await resolveTourChoice(words) : null;
      if (byWords?.kind === 'one') choice = byWords;
    }
    if (!choice) {
      const keywords = extractTourKeywords(rawMessage);
      choice = keywords.length ? await resolveTourChoice(keywords.join(' ')) : null;
    }
  } catch (err) {
    console.error('[ai/chat] тур для брони не прочитан', err instanceof Error ? err.message.slice(0, 200) : '');
    return { tour: null, candidates: [] };
  }
  if (choice?.kind === 'none') choice = null;
  if (!choice) {
    // Резолвер слов не нашёл; одна карточка в ходе — она и есть тур.
    if (suggestions.length === 1) return { tour: suggestions[0], candidates: [] };
    const n = narrowToursByText(rawMessage, suggestions);
    return { tour: n && n.base_price > 0 ? n : null, candidates: [] };
  }
  const tours = choiceTours(choice);
  if (choice.kind === 'one' || (choice.kind === 'seller' && tours.length === 1)) {
    const t = tours[0];
    const known = suggestions.find((s) => s.id === t.id);
    if (known) return { tour: known, candidates: [] };
    // Цены нет — «не записана», не ноль (§4.0): форме нечего считать.
    if (t.base_price == null) return { tour: null, candidates: [candidateToSuggestion(t)] };
    return { tour: candidateToSuggestion(t), candidates: [] };
  }
  const cands = tours.map(candidateToSuggestion);
  // Несколько туров — сужаем по словам реплики и месяцу даты (ретест 01.11:
  // «зимнюю рыбалку 15.11» → 36 «ноябрь — январь», не 37 и не осенняя).
  const narrowed = narrowToursByText(rawMessage, cands.length ? cands : suggestions);
  if (narrowed && narrowed.base_price > 0) return { tour: narrowed, candidates: [] };
  return { tour: null, candidates: cands };
}

const MONTH_STEMS = ['янв', 'фев', 'мар', 'апр', 'ма[йя]', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTH_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Основы слов, общие для любой брони: по ним тур не различить, а лишняя
 * общая основа уравнивает счёт и прячет настоящее совпадение.
 */
const GENERIC_STEMS = new Set([
  'хоч', 'хоте', 'брон', 'забр', 'заяв', 'запи', 'офор', 'пожа', 'нужн', 'можн', 'посе', 'пое',
  'book', 'want', 'trip', 'tour', 'plea', 'requ', 'наше', 'чело', 'взро', 'дете', 'согл', 'теле',
]);

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

function stemsOf(text: string): string[] {
  const t = norm(text);
  const ru = (t.match(/[а-я]{5,}/g) ?? []).map((w) => w.slice(0, 4));
  const en = (t.match(/[a-z]{5,}/g) ?? []).map((w) => w.slice(0, 5));
  return [...new Set([...ru, ...en])].filter((st) => !GENERIC_STEMS.has(st) && !GENERIC_STEMS.has(st.slice(0, 4)));
}

/** Пары иероглифов реплики: «温泉», «火山» — кусок названия на китайском. */
function cjkPairs(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  }
  return [...new Set(out)];
}

/** Месяц даты в реплике: 15.11, 15.11.2026, 2026-11-15, «15 ноября», «in November». */
export function monthOfText(text: string): number | null {
  const t = norm(text);
  const iso = /\b20\d{2}-(\d{2})-\d{2}\b/.exec(t);
  if (iso) return Number(iso[1]);
  const dm = /\b\d{1,2}\.(\d{1,2})(?:\.\d{2,4})?\b/.exec(t);
  if (dm) return Number(dm[1]);
  const RU_MONTH = [/^январ[ьяе]$/, /^феврал[ьяе]$/, /^март[ае]?$/, /^апрел[ьяе]$/, /^ма[йяе]$/, /^июн[ьяе]$/,
    /^июл[ьяе]$/, /^август[ае]?$/, /^сентябр[ьяе]$/, /^октябр[ьяе]$/, /^ноябр[ьяе]$/, /^декабр[ьяе]$/];
  for (const w of t.match(/[а-я]+/g) ?? []) {
    const i = RU_MONTH.findIndex((re) => re.test(w));
    if (i >= 0) return i + 1;
  }
  const en = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|t|tember|ober|ember)?\b/.exec(t);
  if (en) return MONTH_EN.indexOf(en[1]!) + 1;
  return null;
}

/**
 * Один тур, однозначно названный в реплике; иначе null. По порядку:
 * адрес тура (slug) или полное название; затем больше всего общих основ
 * слов (русские, английские, пары иероглифов) без общих слов брони;
 * при равенстве — месяц даты в названии. Ничья — null: не угадываем.
 */
export function narrowToursByText<T extends { title: string; slug?: string | null }>(text: string, tours: T[]): T | null {
  if (tours.length < 2) return null;
  const t = norm(text);
  const exact = tours.filter((x) =>
    (x.slug && x.slug.length >= 4 && t.includes(norm(x.slug)))
    || (norm(x.title).trim().length >= 6 && t.includes(norm(x.title).trim())));
  if (exact.length === 1) return exact[0]!;
  const keys = [...stemsOf(text), ...cjkPairs(text)];
  if (keys.length === 0) return null;
  const scored = tours.map((x) => {
    const title = norm(x.title);
    return { x, n: keys.filter((k) => title.includes(k)).length };
  });
  const best = Math.max(0, ...scored.map((s) => s.n));
  if (best === 0) return null;
  let pool = scored.filter((s) => s.n === best).map((s) => s.x);
  const m = pool.length > 1 ? monthOfText(text) : null;
  if (m && m >= 1 && m <= 12) {
    const re = new RegExp(MONTH_STEMS[m - 1]!, 'i');
    const reEn = new RegExp(MONTH_EN[m - 1]!, 'i');
    const byMonth = pool.filter((x) => re.test(norm(x.title)) || reEn.test(x.title));
    if (byMonth.length) pool = byMonth;
  }
  return pool.length === 1 ? pool[0]! : null;
}
