/**
 * get_tour_availability — свободные даты и места конкретного тура.
 *
 * Один мозг — два протокола: инструмент живёт в реестре Кузьмича и через него
 * же отдаётся публичному MCP (Эволюция 3.0, п.4 — MCP-бронирование, владелец
 * 08.08: «делай»). Занятость — ТОЛЬКО из fetchAvailabilityForTour (движок
 * планера, реальные брони) — тот же расчёт, что у гейта брони и share-API
 * плана. Свой SQL по tour_availability здесь запрещён: разойдётся с гейтом,
 * и агент пообещает места, по которым бронь отклонят.
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { tourKeepsSchedule } from '@/lib/seat-requests/service';
import { getPublicBaseUrl } from '@/lib/config';
import { tourPath } from '@/lib/tours/tour-url';
import { createPlannerCache, fetchAvailabilityForTour } from '@/lib/planner';
import { priceFromUnit, priceWithUnitWords } from '@/lib/tours/price-label';
import { containsPattern, escapeLike } from '@/lib/db/like';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { PriceTierMissError } from '@/lib/tours/price-tiers';
import { honestTourPrice, loadPricingContext, composeHonestPrice } from '@/lib/tours/honest-price';
import { requestWindow, windowLabel, type RequestWindow } from '@/lib/tours/request-window';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { orderOffersBy } from '@/lib/tours/offer-order';
import { loadPlaceOffersForTour } from '@/lib/places/place-tours';
import { ruPlacePath } from '@/lib/zh/pages';
import { plural } from '@/lib/home/data-freshness';
import { operatorPagePath } from '@/lib/operators/page-link';

export interface ResolvedTour {
  id: number;
  title: string;
  operator_id: string | null;
  /** Адрес карточки (ЧПУ, 1114). NULL — только по числу. */
  slug?: string | null;
  base_price: number | null;
  /** За что назначена цена; null — не записано. */
  price_unit: string | null;
  /** Длительность — для цены «за человека в день» (tourDurationDays). */
  multi_day_count?: number | null;
  duration_hours?: number | null;
  /** Сезон — окно дат без календаря (lib/tours/request-window). */
  duration_type?: string | null;
  season_start?: string | null;
  season_end?: string | null;
}

/**
 * Тур по названию, ключевому слову, номеру или имени продавца — один резолвер
 * для get_tour_details, get_tour_availability, create_booking_request, handoff
 * и брони в мессенджере. Только тур на витрине (publicTourSql): черновик
 * оператора (is_published = false) через MCP не находился бы ни картой, ни
 * заявкой. Отказ базы — исключение (с логом), а не «тура нет» (§4.0).
 *
 * Ранг совпадения названия (17.10): точное название → начинается с запроса →
 * содержит запрос → совпало только описание, вид или место. «Долина гейзеров
 * (вертолёт)» начинается с запроса и обходит «Дачные источники (Малая Долина
 * гейзеров)».
 *
 * Несколько предложений (слово владельца 29.10, «1в 2б 3 да»). До 29.10 при
 * равном ранге побеждало короче название, затем самый дешёвый — и заявка
 * «на Горелый» уходила той компании, чьё название короче. Выбор продавца по
 * длине строки — ровно то, чего правило 1в не допускает. Исходы:
 *   - `one` — лучший ранг у туров одной компании: продавец ясен, тур внутри
 *     компании — первый по правилу 1в (lib/tours/offer-order);
 *   - `ambiguous` — лучший ранг у туров двух и более компаний: инструмент,
 *     который пишет (заявка), не выбирает продавца за человека, а называет
 *     всех в порядке правила и просит номер тура;
 *   - `weak` — ни у одного тура нет всех слов запроса (ниже);
 *   - `seller` — запрос назвал продавца, а не тур (ниже);
 *   - `none` — такого тура нет.
 *
 * ── Имя продавца и частичное совпадение (ловушка MCP 29.10, name-search) ──
 *
 * Резолвер не знал имён продавцов. get_tour_details на фамилию гида или на
 * отличительное слово из имени компании отвечал «тура нет», хотя get_tours в
 * ту же минуту отдавал их туры. А на полное имя компании из двух слов —
 * «подходят туры 2 компаний» и ни одного её тура: запасной путь по основам
 * пропускал тур, если совпала ЛЮБАЯ одна основа из N, и общее слово имени
 * («Камчатка») находило чужие туры. Будь компания одна — исход `one`, и
 * create_booking_request писал заявку с телефоном человека продавцу, которого
 * тот не называл.
 *
 * Теперь:
 *   - запасной путь по основам: лучший ранг покрывает НЕ все значимые основы
 *     запроса — исход `weak` («совпали только слова …; «X» не найдено»), а не
 *     `one`, при любом числе компаний; пишущий инструмент по нему заявку не
 *     создаёт;
 *   - продавец по вхождению имени (matchSellerName): в запросе есть слова
 *     имени живого продавца — в любом порядке и падеже, той же нормализацией,
 *     что у tourQueryStems. Продавец — партнёр хотя бы с одним туром на
 *     витрине (тот же шлюз): туроператор или гид с авторскими турами; одни
 *     черновики продавцом не делают. Поиск сужается до его туров, остаток
 *     запроса ищется среди них: остатка нет — `seller` со списком и страницей
 *     продавца; нашёлся — `one` или список внутри продавца; не нашёлся —
 *     `seller` с «тура «…» у продавца нет»;
 *   - сужение — только по ОТЛИЧИТЕЛЬНОМУ слову имени: такому, которого нет в
 *     названии, описании, виде и месте живых туров других компаний (те же
 *     четыре поля, где ищет фраза). Имя из одних общих слов («Северная Рыбалка»)
 *     туры других компаний не прячет: ответ называет и продавца, и их туры по
 *     словам запроса — оба списка (§0: имя не поднимает продавца на общих
 *     запросах). Часть имени без отличительного слова продавцом не считается
 *     вовсе: «Северная» — не запрос о «Северной Заимке»;
 *   - точное название тура сильнее всего: его имя продавца не перебивает.
 *     Фраза внутри названия (ранги 1–2) уступает только отличительному имени
 *     — тогда все такие туры и так его (слова нет ни у кого другого), и
 *     ответ — его список, а не первый тур: слово имени в скобках своего же
 *     тура (имя гостиницы, например) — не выбор тура. Имя из общих слов ответ
 *     по названию не меняет: туры, где фраза стоит в названии, называются как
 *     раньше.
 */
const TITLE_RANK_SQL = `(CASE WHEN lower(ot.title) = lower($2) THEN 0 WHEN ot.title ILIKE $3 THEN 1 WHEN ot.title ILIKE $1 THEN 2 ELSE 3 END)`;

/** Колонки кандидата: тур, продавец, главное место (если видимо) и ближайшая свободная дата. */
const CANDIDATE_COLUMNS = `ot.id, ot.title, ot.operator_id, ot.base_price, ot.price_unit, ot.slug,
       ot.multi_day_count, ot.duration_hours, ot.duration_type,
       ot.season_start::text AS season_start, ot.season_end::text AS season_end,
       ot.main_place_id,
       p.name AS operator_name,
       pl.name AS place_name, pl.slug AS place_slug, pl.ark_id::text AS place_ark_id,
       ${nearestFreeDateSql('ot')} AS nearest_free_date`;

/** Откуда и шлюз витрины — одной строкой: запрос кандидатов без шлюза не собрать. */
const CANDIDATE_FROM = `FROM operator_tours ot
  LEFT JOIN partners p ON p.id = ot.operator_id
  LEFT JOIN places pl ON pl.id = ot.main_place_id AND pl.is_visible = TRUE AND pl.merged_into_id IS NULL
 WHERE ${publicTourSql('ot')}`;

function startsPattern(q: string): string {
  return `${escapeLike(q)}%`;
}

/** Слово текста: как написано и нормализованное (нижний регистр, ё → е). */
interface TextWord {
  raw: string;
  norm: string;
}

/** Слова текста; граница — всё, что не буква и не цифра (кавычки, дефис, скобки). */
function wordsOf(text: string): TextWord[] {
  return text.split(/[^a-zA-Zа-яА-ЯёЁ0-9]+/).filter(Boolean)
    .map((raw) => ({ raw, norm: raw.toLowerCase().replace(/ё/g, 'е') }));
}

/** Основа слова: без двух последних букв у длинных, не короче четырёх. */
function stemOf(norm: string): string {
  return norm.length >= 5 ? norm.slice(0, Math.max(4, norm.length - 2)) : norm;
}

/**
 * Служебные слова — не тур и не имя: «туры Тихой Заимки» — запрос о
 * продавце без остатка, «гид Кедровец» — тоже. В покрытии слов запасного
 * пути они не требуются: «туры Толбачик» не становится частичным совпадением
 * из-за того, что слова «туры» нет в названии.
 */
const FILLER_WORDS = new Set([
  'тур', 'туры', 'тура', 'туров', 'туру', 'туром', 'турах',
  'экскурсия', 'экскурсии', 'экскурсию', 'экскурсией', 'экскурсий',
  'гид', 'гида', 'гиду', 'гидом', 'гиде',
  'компания', 'компании', 'компанию', 'компанией',
  'оператор', 'оператора', 'оператору', 'оператором', 'туроператор', 'туроператора',
  'продавец', 'продавца', 'хочу', 'хотим', 'нужен', 'нужна', 'нужно', 'интересует',
  'покажи', 'расскажи', 'какие', 'какой', 'есть', 'весь', 'все', 'всех',
  'от', 'у', 'к', 'в', 'на', 'с', 'со', 'по', 'из', 'и', 'про', 'для',
  'tour', 'tours', 'guide', 'company', 'operator',
]);

interface StemWord {
  stem: string;
  /** Слово запроса, как написано: для ответа «совпали только слова …». */
  word: string;
  filler: boolean;
}

/** Значимые слова запроса (от 4 букв) с основами, без повторов основы, не больше пяти. */
function queryStemWords(q: string): StemWord[] {
  const out: StemWord[] = [];
  for (const w of wordsOf(q)) {
    if (w.norm.length < 4) continue;
    const stem = stemOf(w.norm);
    if (!out.some((s) => s.stem === stem)) out.push({ stem, word: w.raw, filler: FILLER_WORDS.has(w.norm) });
  }
  return out.slice(0, 5);
}

/** Основы значимых слов запроса (от 4 букв), не больше пяти. */
export function tourQueryStems(q: string): string[] {
  return queryStemWords(q).map((s) => s.stem);
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Окончание из одних букв словоизменения («ой», «ая», «ов», «ем»): «Тихой» и «Тихая» — одно слово. */
const INFLECTION_TAIL = /^[аяоеиыуюйьмхв]{0,3}$/;

/**
 * Одно ли это слово в разных падежах (слова нормализованы): «Кедровца» и
 * «Кедровец», «Кедровцем» и «Кедровец» (беглая гласная), «Заимкой» и
 * «Заимка», «Тихой» и «Тихая», «вулканы» и «вулканов». Совпадение — одно из
 * четырёх: основы равны; каждое слово начинается с основы другого; общее
 * начало от пяти букв, и разнятся не больше трёх последних букв длинного
 * слова; общее начало от трёх букв, а дальше у обоих — только окончание.
 * «Рыбака» — не «рыбалка», «брусника» — не «Брусничкин», «сопка» — не
 * «сопло». Похожести и триграмм нет намеренно: у тёзок они совпадают.
 */
export function sameWord(a: string, b: string): boolean {
  const sa = stemOf(a);
  const sb = stemOf(b);
  if (sa === sb) return true;
  if (a.startsWith(sb) && b.startsWith(sa)) return true;
  const common = commonPrefixLength(a, b);
  if (common >= 5 && common >= Math.max(a.length, b.length) - 3) return true;
  return common >= 3 && INFLECTION_TAIL.test(a.slice(common)) && INFLECTION_TAIL.test(b.slice(common));
}

/** Общее начало двух совпавших слов, не длиннее короткой основы: им ищется слово у других компаний. */
function sharedKey(a: string, b: string): string {
  return a.slice(0, Math.min(commonPrefixLength(a, b), stemOf(a).length, stemOf(b).length));
}

export interface SellerNameMatch {
  /** full — в запросе все значимые слова имени; partial — только часть. */
  coverage: 'full' | 'partial';
  /** Общее начало каждого совпавшего слова имени со словом запроса: им судится отличительность. */
  keys: string[];
  /** Номера слов запроса, покрывших имя: остаток запроса считается без них. */
  used: number[];
}

/**
 * Есть ли в запросе имя продавца. Значимые слова имени — от четырёх букв, без
 * служебных («ООО», «ИП» короче и отпадают сами); нет таких — имени не
 * сопоставить, null. Порядок слов и падеж не важны.
 */
export function matchSellerName(query: string, name: string | null | undefined): SellerNameMatch | null {
  if (typeof name !== 'string') return null;
  const nameWords: string[] = [];
  for (const w of wordsOf(name)) {
    if (w.norm.length >= 4 && !FILLER_WORDS.has(w.norm) && !nameWords.includes(w.norm)) nameWords.push(w.norm);
  }
  if (nameWords.length === 0) return null;
  const queryWords = wordsOf(query);
  const keys: string[] = [];
  const used: number[] = [];
  for (const n of nameWords) {
    const i = queryWords.findIndex((w) => w.norm.length >= 4 && !FILLER_WORDS.has(w.norm) && sameWord(w.norm, n));
    if (i < 0) continue;
    keys.push(sharedKey(queryWords[i].norm, n));
    if (!used.includes(i)) used.push(i);
  }
  if (keys.length === 0) return null;
  return { coverage: keys.length === nameWords.length ? 'full' : 'partial', keys, used };
}

/**
 * Остаток запроса без слов имени продавца и служебных слов; короткие слова по
 * краям («у», «от») отрезаются. Нет ничего от четырёх букв — остатка нет.
 */
export function queryRemainder(query: string, used: readonly number[]): string | null {
  const rest = wordsOf(query).filter((w, i) => !used.includes(i) && !FILLER_WORDS.has(w.norm));
  let s = 0;
  let e = rest.length;
  while (s < e && rest[s].norm.length < 4) s++;
  while (e > s && rest[e - 1].norm.length < 4) e--;
  return e > s ? rest.slice(s, e).map((w) => w.raw).join(' ') : null;
}

/** Главное место тура, если оно записано и видимо. */
export interface CandidatePlace {
  id: string;
  name: string;
  slug: string | null;
  ark_id: string | null;
}

export interface TourCandidate extends ResolvedTour {
  /** Витринное имя продавца (partners.name); null — не прочитано. */
  operator_name: string | null;
  main_place_id: string | null;
  /** Главное место, если записано и видимо; иначе null. */
  place: CandidatePlace | null;
  /** Ближайшая дата со свободными местами (lib/tours/nearest-free-date). */
  nearest_free_date: string | null;
}

/** Продавец, найденный по имени: для подписи и ссылки на его страницу. */
export interface SellerMatch {
  id: string;
  name: string;
  /** partners.category: 'guide' — «гид», иначе «компания». */
  category: string | null;
  slug: string | null;
  is_public: boolean | null;
}

export type TourChoice =
  | { kind: 'one'; tour: TourCandidate }
  | { kind: 'ambiguous'; candidates: TourCandidate[] }
  /**
   * Ни у одного тура нет всех значимых слов запроса: matched — слова,
   * совпавшие у кандидатов, missing — не совпавшие ни у одного из них.
   */
  | { kind: 'weak'; candidates: TourCandidate[]; matched: string[]; missing: string[] }
  /**
   * Запрос назвал продавца. tours — его туры по правилу 1в; missing — остаток
   * запроса, которого среди них нет; others — при имени из общих слов туры
   * других компаний по словам запроса (null — имя отличительное, сужение честное).
   */
  | { kind: 'seller'; sellers: SellerMatch[]; tours: TourCandidate[]; missing: string | null; others: TourCandidate[] | null }
  | { kind: 'none' };

export type SellerChoice = Extract<TourChoice, { kind: 'seller' }>;
export type WeakChoice = Extract<TourChoice, { kind: 'weak' }>;

interface CandidateRow {
  id: number | string;
  title: string;
  operator_id: string | null;
  base_price: number | string | null;
  price_unit: string | null;
  slug: string | null;
  multi_day_count: number | null;
  duration_hours: number | string | null;
  duration_type: string | null;
  season_start: string | null;
  season_end: string | null;
  main_place_id: string | null;
  operator_name: string | null;
  place_name: string | null;
  place_slug: string | null;
  place_ark_id: string | null;
  nearest_free_date: string | null;
  /** Ранг: меньше — лучше. */
  rank?: number | string | null;
  /** Запасной путь: совпала ли каждая основа запроса (по порядку основ). */
  stem_hits?: boolean[] | null;
}

function toCandidate(r: CandidateRow): TourCandidate {
  const placeId = typeof r.main_place_id === 'string' && r.main_place_id !== '' ? r.main_place_id : null;
  return {
    id: Number(r.id),
    title: String(r.title ?? ''),
    operator_id: r.operator_id ?? null,
    slug: r.slug ?? null,
    base_price: r.base_price == null ? null : Number(r.base_price),
    price_unit: r.price_unit ?? null,
    multi_day_count: r.multi_day_count ?? null,
    duration_hours: r.duration_hours == null ? null : Number(r.duration_hours),
    duration_type: r.duration_type ?? null,
    season_start: r.season_start ?? null,
    season_end: r.season_end ?? null,
    operator_name: r.operator_name ?? null,
    main_place_id: placeId,
    place: placeId && r.place_name
      ? { id: placeId, name: r.place_name, slug: r.place_slug ?? null, ark_id: r.place_ark_id ?? null }
      : null,
    nearest_free_date: r.nearest_free_date ?? null,
  };
}

/** Ключ компании: продавец; тур без продавца — сам себе компания. */
function companyKey(t: TourCandidate): string {
  return t.operator_id ?? `tour:${t.id}`;
}

const byOfferOrder = (t: TourCandidate) => ({ id: t.id, nearestFreeDate: t.nearest_free_date });

/** Кандидаты лучшего ранга — по правилу 1в: тот же порядок, что у витрин. */
function bestCandidates(rows: CandidateRow[], rankOf: (r: CandidateRow) => number): TourCandidate[] {
  if (rows.length === 0) return [];
  const best = Math.min(...rows.map(rankOf));
  return orderOffersBy(rows.filter((r) => rankOf(r) === best).map(toCandidate), byOfferOrder);
}

/**
 * Из строк лучшего ранга — исход. Порядок кандидатов — правило 1в: тот же,
 * что у витрин, ничего не решает длина названия или цена.
 */
function choose(rows: CandidateRow[], rankOf: (r: CandidateRow) => number): TourChoice {
  const ordered = bestCandidates(rows, rankOf);
  if (ordered.length === 0) return { kind: 'none' };
  const companies = new Set(ordered.map(companyKey));
  return companies.size > 1 ? { kind: 'ambiguous', candidates: ordered } : { kind: 'one', tour: ordered[0] };
}

const phraseRank = (r: CandidateRow) => Number(r.rank ?? 3);

/** Круг поиска по продавцам: только их туры, все кроме их или вся витрина (null). */
type SellerScope = { only: string[] } | { except: string[] } | null;

function scopeClause(scope: SellerScope, n: number): { sql: string; params: unknown[] } {
  if (!scope) return { sql: '', params: [] };
  return 'only' in scope
    ? { sql: ` AND ot.operator_id = ANY($${n}::uuid[])`, params: [scope.only] }
    : { sql: ` AND (ot.operator_id IS NULL OR NOT (ot.operator_id = ANY($${n}::uuid[])))`, params: [scope.except] };
}

/** Фраза целиком — в названии, описании, виде или месте; rank — ранг названия. */
async function phraseRows(q: string, scope: SellerScope): Promise<CandidateRow[]> {
  const sc = scopeClause(scope, 4);
  const { rows } = await pool.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS}, ${TITLE_RANK_SQL} AS rank ${CANDIDATE_FROM}
        AND (ot.title ILIKE $1 OR ot.short_description ILIKE $1 OR ot.activity_type ILIKE $1 OR ot.location_name ILIKE $1)${sc.sql}`,
    [containsPattern(q), q, startsPattern(q), ...sc.params],
  );
  return rows;
}

interface Found {
  choice: TourChoice;
  /** Кандидаты лучшего ранга по правилу 1в (у `one` — все туры компании, а не первый). */
  candidates: TourCandidate[];
}

const NOTHING: Found = { choice: { kind: 'none' }, candidates: [] };

/**
 * Запасной путь по основам: фраза целиком не нашлась («Авачинский
 * восхождение» — слова из перевода стоят не подряд). Основы ищутся в
 * названии и месте, больше совпавших — лучше. Служебные слова («туры»)
 * ищутся, только если других нет. Меньше двух основ — пути нет (null).
 *
 * Лучший ранг покрывает не все основы — `weak`: частичное совпадение
 * «подходит» не называется, и заявка по нему не пишется (ловушка 29.10).
 */
async function wordsSearch(q: string, scope: SellerScope): Promise<Found | null> {
  const all = queryStemWords(q);
  if (all.length < 2) return null;
  const real = all.filter((s) => !s.filler);
  const stems = real.length > 0 ? real : all;
  const hit = (i: number) => `(ot.title ILIKE $${i + 1} OR ot.location_name ILIKE $${i + 1})`;
  const sc = scopeClause(scope, stems.length + 1);
  const { rows } = await pool.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS}, ARRAY[${stems.map((_, i) => hit(i)).join(', ')}] AS stem_hits ${CANDIDATE_FROM}
        AND (${stems.map((_, i) => hit(i)).join(' OR ')})${sc.sql}`,
    [...stems.map((s) => containsPattern(s.stem)), ...sc.params],
  );
  if (rows.length === 0) return NOTHING;
  // Совпадения считает база; строки без отметок (их нет у настоящего запроса)
  // ничего не покрывают — «не знаю» не равно «совпало» (§4.0).
  const hitsOf = (r: CandidateRow) => stems.map((_, i) => Array.isArray(r.stem_hits) && r.stem_hits[i] === true);
  const rankOf = (r: CandidateRow) => -hitsOf(r).filter(Boolean).length;
  const candidates = bestCandidates(rows, rankOf);
  const best = Math.min(...rows.map(rankOf));
  if (-best === stems.length) return { choice: choose(rows, rankOf), candidates };
  const top = rows.filter((r) => rankOf(r) === best).map(hitsOf);
  const seen = stems.map((_, i) => top.some((h) => h[i]));
  return {
    choice: {
      kind: 'weak', candidates,
      matched: stems.filter((_, i) => seen[i]).map((s) => s.word),
      missing: stems.filter((_, i) => !seen[i]).map((s) => s.word),
    },
    candidates,
  };
}

/** Фраза, затем основы — в заданном круге продавцов. */
async function searchTours(q: string, scope: SellerScope): Promise<Found> {
  const phrase = await phraseRows(q, scope);
  if (phrase.length > 0) return { choice: choose(phrase, phraseRank), candidates: bestCandidates(phrase, phraseRank) };
  return (await wordsSearch(q, scope)) ?? NOTHING;
}

interface SellerRow {
  seller_id: string;
  seller_name: string | null;
  seller_category: string | null;
  seller_slug: string | null;
  seller_is_public: boolean | null;
}

/**
 * Есть ли основа слова имени у живых туров ДРУГИХ компаний — в названии,
 * описании, виде или месте (те же поля, где ищет фраза). Ответ — по паре
 * «продавец:основа»; пара без ответа — «не знаю», и отличительным такое слово
 * не считается (§4.0).
 */
async function keysElsewhere(pairs: ReadonlyArray<{ sellerId: string; key: string }>): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (pairs.length === 0) return out;
  const { rows } = await pool.query<{ seller_id: string; key: string; elsewhere: boolean | null }>(
    `SELECT k.seller_id::text AS seller_id, k.key,
            EXISTS (SELECT 1 FROM operator_tours ot
                     WHERE ${publicTourSql('ot')}
                       AND ot.operator_id IS DISTINCT FROM k.seller_id
                       AND (ot.title ILIKE k.pattern OR ot.short_description ILIKE k.pattern
                            OR ot.activity_type ILIKE k.pattern OR ot.location_name ILIKE k.pattern)) AS elsewhere
       FROM unnest($1::uuid[], $2::text[], $3::text[]) AS k(seller_id, key, pattern)`,
    [pairs.map((p) => p.sellerId), pairs.map((p) => p.key), pairs.map((p) => containsPattern(p.key))],
  );
  for (const r of rows) {
    if (typeof r.elsewhere === 'boolean') out.set(`${r.seller_id}:${r.key}`, r.elsewhere);
  }
  return out;
}

/**
 * Продавец по имени в запросе (шапка выше). Кандидаты — партнёры хотя бы с
 * одним туром на витрине; имя сопоставляется в коде (matchSellerName),
 * отличительность совпавших слов — запросом по турам других компаний.
 * inTitles — фраза запроса стоит в названии тура: тогда в счёт идёт только
 * отличительное имя. null — продавца в запросе нет, поиск идёт как раньше.
 */
async function sellerChoice(q: string, inTitles: boolean): Promise<TourChoice | null> {
  if (!wordsOf(q).some((w) => w.norm.length >= 4 && !FILLER_WORDS.has(w.norm))) return null;
  const { rows } = await pool.query<SellerRow>(
    `SELECT p.id::text AS seller_id, p.name AS seller_name, p.category AS seller_category,
            p.slug AS seller_slug, p.is_public AS seller_is_public
       FROM partners p
      WHERE EXISTS (SELECT 1 FROM operator_tours ot WHERE ot.operator_id = p.id AND ${publicTourSql('ot')})`,
  );
  const matched = rows.flatMap((row) => {
    const m = typeof row.seller_id === 'string' ? matchSellerName(q, row.seller_name) : null;
    return m ? [{ row, m }] : [];
  });
  if (matched.length === 0) return null;
  const elsewhere = await keysElsewhere(matched.flatMap(({ row, m }) => m.keys.map((key) => ({ sellerId: row.seller_id, key }))));
  const exclusive = matched.filter(({ row, m }) => m.keys.some((key) => elsewhere.get(`${row.seller_id}:${key}`) === false));
  const exclusiveFull = exclusive.filter(({ m }) => m.coverage === 'full');
  const narrowed = exclusiveFull.length > 0 ? exclusiveFull : exclusive;
  // Отличительного слова нет ни у кого: продавец — только при полном имени,
  // и тогда рядом туры других компаний; часть общего имени — не продавец.
  const chosen = narrowed.length > 0 ? narrowed : inTitles ? [] : matched.filter(({ m }) => m.coverage === 'full');
  if (chosen.length === 0) return null;

  const ids = chosen.map(({ row }) => row.seller_id);
  const { rows: tourRows } = await pool.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} ${CANDIDATE_FROM}
        AND ot.operator_id = ANY($1::uuid[])`,
    [ids],
  );
  const tours = orderOffersBy(tourRows.map(toCandidate), byOfferOrder);
  // Туры сняли между двумя запросами — продавца на витрине уже нет.
  if (tours.length === 0) return null;
  const sellers: SellerMatch[] = chosen.map(({ row }) => ({
    id: row.seller_id,
    name: String(row.seller_name),
    category: row.seller_category ?? null,
    slug: row.seller_slug ?? null,
    is_public: row.seller_is_public ?? null,
  })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const rest = queryRemainder(q, [...new Set(chosen.flatMap(({ m }) => m.used))]);
  let missing: string | null = null;
  if (rest) {
    const inner = await searchTours(rest, { only: ids });
    const found = inner.choice.kind === 'one' || inner.choice.kind === 'ambiguous';
    if (found && narrowed.length > 0) return inner.choice;
    if (!found) missing = rest;
  }
  const others = narrowed.length > 0 ? null : (await searchTours(q, { except: ids })).candidates;
  return { kind: 'seller', sellers, tours, missing, others };
}

export async function resolveTourChoice(query: string): Promise<TourChoice> {
  const q = query.trim();
  if (!q) return { kind: 'none' };
  try {
    const idMatch = /^(?:id\s*)?(\d+)$/i.exec(q);
    if (idMatch) {
      const { rows } = await pool.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} ${CANDIDATE_FROM}
            AND ot.id = $1`,
        [Number(idMatch[1])],
      );
      // Номер, которого нет на витрине, — это «тура нет», а не повод искать
      // «%7%» по названиям: так заявка на снятый тур 7 уходила по самому
      // дешёвому туру, где в описании есть семёрка (проверка MCP 29.09).
      return rows[0] ? { kind: 'one', tour: toCandidate(rows[0]) } : { kind: 'none' };
    }
    const phrase = await phraseRows(q, null);
    // Точное название тура — самое сильное совпадение: имя продавца его не перебивает.
    if (phrase.some((r) => phraseRank(r) === 0)) return choose(phrase, phraseRank);
    const seller = await sellerChoice(q, phrase.some((r) => phraseRank(r) <= 2));
    if (seller) return seller;
    if (phrase.length > 0) return choose(phrase, phraseRank);
    return (await wordsSearch(q, null))?.choice ?? { kind: 'none' };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[tour-availability] тур не прочитан', { sqlstate: e?.code, message: e?.message });
    throw err;
  }
}

/**
 * Старый вход «один тур или ничего». Неоднозначность здесь — тоже null:
 * выбрать продавца за человека резолвер не вправе. Новые вызовы — только
 * resolveTourChoice, где неоднозначность названа.
 */
export async function resolveTourByQuery(query: string): Promise<ResolvedTour | null> {
  const choice = await resolveTourChoice(query);
  return choice.kind === 'one' ? choice.tour : null;
}

const CANDIDATES_SHOWN = 10;

/**
 * Список кандидатов для агента: номер, название, компания, цена с единицей.
 * Больше десяти — «и ещё N» с подсказкой, где остальные.
 */
export function candidateLines(candidates: readonly TourCandidate[], limit = CANDIDATES_SHOWN, moreHint = 'get_tours'): string[] {
  const lines = candidates.slice(0, limit).map((c) => {
    const price = priceWithUnitWords(c.base_price, c.price_unit) ?? 'цена не указана';
    return `- ID${c.id} «${c.title}» — ${c.operator_name ?? 'компания не записана'} — ${price}`;
  });
  if (candidates.length > limit) lines.push(`- и ещё ${candidates.length - limit} — ${moreHint}`);
  return lines;
}

/** Строка о неоднозначности для чтения (детали, даты): о ком ответ и кого ещё назвать. */
export function ambiguityNote(query: string, candidates: readonly TourCandidate[]): string {
  const companies = new Set(candidates.map(companyKey)).size;
  const list = candidates.slice(0, CANDIDATES_SHOWN)
    .map((c) => `ID${c.id} — ${c.operator_name ?? 'компания не записана'}`).join('; ');
  const more = candidates.length > CANDIDATES_SHOWN ? `; и ещё ${candidates.length - CANDIDATES_SHOWN}` : '';
  return `По запросу «${query}» подходят туры ${companies} ${plural(companies, 'компании', 'компаний', 'компаний')}: ${list}${more}. `
    + 'Ниже — первый по порядку платформы (правило, а не рекомендация). Назови человеку все и уточни номер тура; не выбирай компанию за него.';
}

/** «гид «…»» или «компания «…»» — как продавец назван в ответе. */
export function sellerLabel(s: SellerMatch): string {
  return `${s.category === 'guide' ? 'гид' : 'компания'} «${s.name}»`;
}

/** Полный адрес собственной страницы продавца; null — страницы нет (карточка закрыта или без адреса). */
export function sellerPageUrl(s: SellerMatch): string | null {
  const path = operatorPagePath({ slug: s.slug, is_public: s.is_public });
  return path ? `${getPublicBaseUrl()}${path}` : null;
}

/**
 * Ответ о продавце: кто он, его страница, его туры по правилу 1в; при имени
 * из общих слов — и туры других компаний по словам запроса. Ни один список
 * не прячется, первым тур не выбирается (§0).
 */
export function sellerChoiceLines(query: string, c: SellerChoice): string[] {
  const one = c.sellers.length === 1;
  const lines = [
    `По запросу «${query}» найден ${one ? 'продавец' : 'не один продавец'} — ${c.sellers.map(sellerLabel).join(', ')}. `
      + 'Это имя продавца, а не название тура.',
  ];
  for (const s of c.sellers) {
    const url = sellerPageUrl(s);
    const whose = one ? 'продавца' : sellerLabel(s);
    lines.push(url ? `Страница ${whose} на Ведаре: ${url}` : `Своей страницы на Ведаре у ${one ? 'продавца' : sellerLabel(s)} нет.`);
  }
  if (c.missing) {
    lines.push(`Тура «${c.missing}» у ${one ? 'продавца' : 'этих продавцов'} нет — ниже все ${one ? 'его' : 'их'} туры. `
      + `Туры «${c.missing}» других компаний — get_tour_details с запросом «${c.missing}» без имени продавца.`);
  }
  const page = one ? sellerPageUrl(c.sellers[0]) : null;
  lines.push(
    `Туры ${one ? 'продавца' : 'этих продавцов'} на витрине — ${c.tours.length} (порядок — правило платформы, а не рекомендация):`,
    ...candidateLines(c.tours, CANDIDATES_SHOWN, page ? 'все на странице продавца' : 'get_tours'),
  );
  if (c.others) {
    lines.push(
      'Все слова имени есть и в турах других компаний, так что запрос может быть и не о продавце. '
        + 'Туры других компаний по словам запроса — назови человеку оба списка, выбирает он:',
      ...(c.others.length > 0 ? candidateLines(c.others) : ['- туров других компаний по этим словам нет']),
    );
  }
  return lines;
}

/** Ответ о частичном совпадении: какие слова совпали, какие нет, и туры, где совпала часть. */
export function weakChoiceLines(query: string, c: WeakChoice): string[] {
  const quoted = (ws: readonly string[]) => ws.map((w) => `«${w}»`).join(', ');
  const head = c.matched.length === 0
    ? `По запросу «${query}» тура со всеми словами нет.`
    : c.missing.length > 0
      ? `По запросу «${query}» тура со всеми словами нет — совпали только слова ${quoted(c.matched)}; ${quoted(c.missing)} не найдено.`
      : `По запросу «${query}» тура со всеми словами нет — слова ${quoted(c.matched)} встречаются только в разных турах.`;
  return [
    `${head} Это частичное совпадение: не называй эти туры подходящими.`,
    'Туры, где совпала часть слов (порядок — правило платформы, а не рекомендация):',
    ...candidateLines(c.candidates),
  ];
}

/** Строки ответа-списка: о продавце или о частичном совпадении. */
export function choiceListLines(query: string, c: SellerChoice | WeakChoice): string[] {
  return c.kind === 'seller' ? sellerChoiceLines(query, c) : weakChoiceLines(query, c);
}

/** Ответ читающего инструмента (детали, даты) на продавца или частичное совпадение — список без дат и деталей одного тура. */
export function choiceListAnswer(query: string, c: SellerChoice | WeakChoice): string {
  return [
    ...choiceListLines(query, c),
    'Детали и даты — get_tour_details или get_tour_availability с номером тура (ID). '
      + 'Не выбирай тур и компанию за человека — назови список и спроси, какой нужен.',
  ].join('\n');
}

/**
 * Хвост ответа о туре: «к месту ещё N предложений» (слово владельца 29.10,
 * «3 да»). Только по записанной связи тура с местом; нет связи, никого
 * больше или отказ чтения — пусто (отказ уже в логе загрузчика).
 */
export async function samePlaceOffersLine(tour: TourCandidate): Promise<string> {
  const r = await loadPlaceOffersForTour({ id: tour.id, main_place_id: tour.main_place_id });
  if (r.state !== 'ok' || r.others === 0) return '';
  return `К месту «${r.place.name}» ещё ${r.others} ${plural(r.others, 'предложение', 'предложения', 'предложений')} других туров — `
    + `get_place_info(«${r.place.name}») или ${getPublicBaseUrl()}${ruPlacePath(r.place)}#tours`;
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/** Дата с годом, если год не текущий: окно сезона бывает в следующем году. */
function dayIn(iso: string, today: string): string {
  return iso.slice(0, 4) === today.slice(0, 4) ? shortDate(iso) : `${shortDate(iso)}.${iso.slice(0, 4)}`;
}

/** Окно дат без календаря для тура (lib/tours/request-window). */
export function tourRequestWindow(tour: ResolvedTour, today: string): RequestWindow {
  return requestWindow({
    season_start: tour.season_start ?? null, season_end: tour.season_end ?? null,
    duration_type: tour.duration_type ?? null, multi_day_count: tour.multi_day_count ?? null,
    duration_hours: tour.duration_hours ?? null,
  }, today);
}

/**
 * Сколько человек: 1–30 (тот же потолок, что у группы в регистрации и брони).
 * Не дано или не число — null: итог не считается, а не считается «за одного».
 */
export function parsePeople(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const k = Math.trunc(n);
  return k >= 1 && k <= 30 ? k : null;
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/** Даты окна по порядку, оба края включительно. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Подряд идущие даты с одинаковой подписью — одним диапазоном: четырнадцать
 * одинаковых строк агент пересказал бы человеку как четырнадцать фактов.
 * Подпись сменилась (сезонное правило цены с середины окна) — новый диапазон.
 */
export function collapseRuns(items: ReadonlyArray<{ date: string; label: string }>): Array<{ from: string; to: string; label: string }> {
  const runs: Array<{ from: string; to: string; label: string }> = [];
  for (const it of items) {
    const last = runs[runs.length - 1];
    const prevDay = last ? new Date(Date.parse(`${last.to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : null;
    if (last && last.label === it.label && prevDay === it.date) last.to = it.date;
    else runs.push({ from: it.date, to: it.date, label: it.label });
  }
  return runs;
}


/**
 * Тур без расписания: все даты окна свободны для заявки (решение владельца
 * 08.10: «сделай все даты свободными, можно только отправить заявку
 * оператору»).
 *
 * До этого инструмент отвечал «свободные даты узнать нельзя» — и внешний
 * агент так и пересказывал человеку все одиннадцать туров «Края Вулканов»:
 * дат нет, ничего не узнать. Правда другая: оператор собирает группу под
 * запрос, и закрытых дат у него нет. Поэтому даты называются свободными —
 * для заявки, с итогом на группу тем же расчётом, что у самой заявки.
 *
 * Чего здесь нет намеренно: числа мест. Календаря у тура нет, и «свободно
 * 10» было бы выдумкой (§4.0). И строк в tour_availability под такие туры
 * никто не заводит: по ним работает автоподтверждение оператора
 * (lib/bookings/auto-confirm), и выдуманный календарь подтверждал бы заявки
 * на даты, которых оператор не давал.
 */
async function onRequestWindow(
  tour: ResolvedTour, from: string, to: string, peopleRaw: string | undefined, notes: string[],
  window: RequestWindow, today: string,
): Promise<string[]> {
  const people = parsePeople(peopleRaw);
  if (peopleRaw != null && peopleRaw.trim() !== '' && people === null) {
    notes.push(`Число людей «${peopleRaw}» не распознано (нужно 1–30) — итог не посчитан.`);
  }
  const dates = datesBetween(from, to);
  let labels: string[];
  if (people !== null && tour.base_price != null) {
    try {
      // Правила цены и ступени группы от даты не зависят — читаются один
      // раз; дата участвует в самом расчёте (сезонные правила).
      const { rules, tiers } = await loadPricingContext(tour.id, from);
      labels = dates.map((d) => {
        try {
          const p = composeHonestPrice({
            baseUnitPrice: Number(tour.base_price), priceUnit: tour.price_unit, participants: people,
            duration: { multi_day_count: tour.multi_day_count ?? null, duration_hours: tour.duration_hours ?? null },
            rules, tiers, ctx: { tourDate: d, guests: people, occupancyPct: 0 },
          });
          return `итого за ${people} чел.: ${rub(p.total)}`;
        } catch (err) {
          if (err instanceof PriceTierMissError) return `для группы из ${people} чел. цену называет оператор`;
          throw err;
        }
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.error('[tour-availability] итог не посчитан', { tourId: tour.id, sqlstate: e?.code, message: e?.message });
      labels = dates.map(() => 'итог не посчитан');
    }
  } else {
    const price = priceFromUnit(tour.base_price, tour.price_unit);
    labels = dates.map(() => price || 'цену называет оператор');
  }
  const runs = collapseRuns(dates.map((date, i) => ({ date, label: labels[i] })));
  const head = window.kind === 'season'
    ? `Тур "${tour.title}" (ID${tour.id}): расписания в системе нет — предварительная бронь только по сезону (${windowLabel(window)}); даты сезона свободны для заявки, оператор собирает группу под запрос:`
    : `Тур "${tour.title}" (ID${tour.id}): расписания в системе нет — все даты свободны для заявки, оператор собирает группу под запрос:`;
  return [
    head,
    ...runs.map((r) => `- ${r.from === r.to ? dayIn(r.from, today)
      : `${r.from.slice(0, 4) === r.to.slice(0, 4) ? shortDate(r.from) : dayIn(r.from, today)}–${dayIn(r.to, today)}`}: свободно для заявки, ${r.label}`),
    'Числа мест у тура без календаря нет — дату и группу подтверждает оператор. '
      + 'create_booking_request с датой отправит ему заявку в мессенджер, ответ — до 2 часов. Не обещай, что место закреплено, до его ответа.',
    ...(people !== null && tour.base_price != null
      ? ['Итог — сумма, которую посчитает заявка на эту дату и число людей (правила цены тура). Трансферы и услуги из «не входит» в неё не включены.']
      : ['Итоговую сумму за группу на дату даёт этот же инструмент с параметром people.']),
  ];
}

/** День через n суток (n может быть отрицательным), YYYY-MM-DD. */
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * Горизонт поиска ближайшей даты — тот же день через год, как `INTERVAL
 * '1 year'` в nearestFreeDateSql (дата «Ближайшая дата» каталога get_tours):
 * 29.02 даёт 28.02, а не 01.03. «+365 дней» разошёлся бы с ним на день в
 * високосный год.
 */
export function yearAhead(today: string): string {
  const md = today.slice(5);
  return `${Number(today.slice(0, 4)) + 1}-${md === '02-29' ? '02-28' : md}`;
}

type NearestSlot =
  | { state: 'found'; date: string; remaining: number }
  | { state: 'none' }
  | { state: 'failed' };

/**
 * Первая дата диапазона со свободными местами — тем же движком, что окно и
 * гейт брони (шапка файла). С числом людей — первая, где мест хватит на всех:
 * дату «свободно 2» при группе из четырёх гейт create_booking_request
 * отклонил бы. Отказ чтения — `failed` со строкой в логе (SQLSTATE пишет сам
 * планер), а не «дат нет» и не общий «занятость недоступна» (§4.0).
 *
 * Без LIMIT: до года строк одного тура, и только в пустой ветке.
 */
async function firstFreeSlot(
  tourId: number, from: string, to: string, people: number | null, side: string, cache: ReturnType<typeof createPlannerCache>,
): Promise<NearestSlot> {
  try {
    const slots = await fetchAvailabilityForTour(String(tourId), from, to, cache);
    const hit = slots.find((s) => s.remaining >= (people ?? 1));
    return hit ? { state: 'found', date: hit.date, remaining: hit.remaining } : { state: 'none' };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[tour-availability] ближайшая дата вне окна не прочитана', { tourId, side, sqlstate: e?.code, message: e?.message });
    return { state: 'failed' };
  }
}

/**
 * Окно пусто, а расписание у тура есть (ловушка MCP 29.10, availability-nearest).
 *
 * До 29.10 ответ был одной фразой «свободных мест с … по … нет, можно
 * проверить другое окно или другой тур». Тур 79 в окне 29.10–11.11 так и
 * отвечал, а get_tours в ту же минуту называл его «Ближайшая дата: 19 июля»:
 * два инструмента одного канала расходились, и агент уводил человека к
 * другому туру, хотя свободный выезд был и платформа его знала. Описание
 * инструмента в MCP при этом обещало «nearest open dates».
 *
 * Теперь пустое окно называет соседей тем же движком:
 *   - после окна — до горизонта в год (тот же, что у «Ближайшей даты»);
 *   - раньше окна — если смотрели не с сегодня: иначе свободная дата раньше
 *     окна осталась бы невидимой, а совет «другой тур» — той же ловушкой,
 *     только для позднего окна;
 *   - окно дальше года — так и сказано, а не молчание.
 * «Другой тур» советуется, только когда пусто и до, и после окна. Дата
 * соседа — НЕ строкой слота «- ДД.ММ (…): свободно N»: сверка каналов
 * (lib/quality/channel-parity) засчитала бы её датой окна.
 *
 * nearest_free_date кандидата здесь не годится: она считается от сегодня, без
 * числа людей, и при date_from в будущем указывает раньше окна.
 */
async function emptyWindowAnswer(
  tour: ResolvedTour, from: string, to: string, today: string, people: number | null,
  cache: ReturnType<typeof createPlannerCache>,
): Promise<string[]> {
  const horizon = yearAhead(today);
  const afterFrom = addDays(to, 1);
  const beforeTo = addDays(from, -1) < horizon ? addDays(from, -1) : horizon;
  const before = from > today
    ? await firstFreeSlot(tour.id, today, beforeTo, people, 'раньше окна', cache)
    : null;
  const after = afterFrom <= horizon
    ? await firstFreeSlot(tour.id, afterFrom, horizon, people, 'после окна', cache)
    : null;
  const forGroup = people !== null ? ` на ${people} чел.` : '';
  const lines = [
    `Тур "${tour.title}" (ID${tour.id}): свободных мест с ${dayIn(from, today)} по ${dayIn(to, today)} нет — по расписанию и броням; не обещай места на эти даты.`,
  ];
  if (before?.state === 'found') {
    lines.push(`Раньше этого окна есть ${people !== null ? `дата, где хватит мест на ${people} чел.,` : 'свободная дата'} — ${dayIn(before.date, today)}, свободно ${before.remaining}; её покажет get_tour_availability с date_from=${before.date}.`);
  } else if (before?.state === 'none') {
    lines.push(`Раньше этого окна, с ${dayIn(today, today)} по ${dayIn(beforeTo, today)}, свободных дат${forGroup} тоже нет.`);
  } else if (before?.state === 'failed') {
    lines.push('Свободные даты раньше этого окна проверить не смог — не говори, что их нет.');
  }
  if (after === null) {
    lines.push(`Дальше года от сегодняшнего дня (после ${dayIn(horizon, today)}) не смотрю.`);
  } else if (after.state === 'found') {
    lines.push(`Ближайшая ${people !== null ? `дата после этого окна, где хватит мест на ${people} чел.,` : 'свободная дата после этого окна'} — ${dayIn(after.date, today)}, свободно ${after.remaining}; её и следующие покажет get_tour_availability с date_from=${after.date}. До неё мест не обещай.`);
  } else if (after.state === 'none') {
    const elsewhere = before === null || before.state === 'none';
    lines.push(`После этого окна до ${dayIn(horizon, today)} свободных дат${forGroup} нет — выезды заняты или не открыты.`
      + (elsewhere ? ' Не обещай места; предложи другой тур.' : ''));
  } else {
    lines.push('Ближайшую свободную дату после этого окна проверить не смог — не говори, что дат нет; предложи повторить позже или страницу тура.');
  }
  return lines;
}

type AvailabilityArgs = { tour?: string; date_from?: string; days?: string; people?: string };

export async function getTourAvailabilityForKuzmich(args: AvailabilityArgs): Promise<string> {
  const tourQuery = (args.tour ?? '').trim();
  if (!tourQuery) return 'Укажи тур: название, ключевое слово или ID.';

  const choice = await resolveTourChoice(tourQuery);
  if (choice.kind === 'none') {
    return `Тур по запросу "${tourQuery}" не найден среди активных. Не выдумывай даты — предложи выбрать тур через get_tours.`;
  }
  // Продавец или частичное совпадение слов — список без дат: даты первого
  // тура из списка выбрали бы тур за человека (ловушка name-search, 29.10).
  if (choice.kind === 'seller' || choice.kind === 'weak') return choiceListAnswer(tourQuery, choice);
  // Туры нескольких компаний: ответ — о первом по правилу 1в, а первой
  // строкой названы все (агент спрашивает человека, а не выбирает за него).
  const tour = choice.kind === 'one' ? choice.tour : choice.candidates[0];
  const body = await availabilityForTour(tour, args);
  const head = choice.kind === 'ambiguous' ? [ambiguityNote(tourQuery, choice.candidates)] : [];
  const tail = choice.kind === 'one' ? await samePlaceOffersLine(choice.tour) : '';
  return [...head, body, ...(tail ? [tail] : [])].join('\n');
}

async function availabilityForTour(tour: ResolvedTour, args: AvailabilityArgs): Promise<string> {

  // «Сегодня» — по Камчатке: даты туров местные. По UTC с 12:00 до 24:00
  // сегодняшнее число на Камчатке уже следующее, и инструмент предлагал
  // вчерашний день как свободный (проба MCP 29.09, 22:05 UTC — «29.09
  // свободно 12» при 30.09 на Камчатке).
  const today = kamchatkaToday();
  const pastFrom = /^\d{4}-\d{2}-\d{2}$/.test(args.date_from ?? '') && (args.date_from as string) < today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(args.date_from ?? '') && (args.date_from as string) >= today
    ? (args.date_from as string)
    : today;
  const daysRaw = Number(args.days);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 31) : 14;
  // Поправки запроса называются, а не делаются молча: агент должен знать,
  // что смотрели не то окно, которое он просил.
  const notes = [
    pastFrom ? `Дата ${args.date_from} уже прошла — показываю с сегодняшнего дня по Камчатке.` : '',
    Number.isFinite(daysRaw) && Math.trunc(daysRaw) > 31 ? 'Окно больше 31 дня не смотрю — показываю 31.' : '',
  ].filter(Boolean);
  const to = new Date(Date.parse(from) + (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const cache = createPlannerCache();
    const slots = await fetchAvailabilityForTour(String(tour.id), from, to, cache);
    if (slots.length === 0) {
      // «Мест нет» — только когда расписание есть и места разобраны. Тур без
      // календаря (оператор берёт без него) — иной случай: места уточняются у
      // оператора, и create_booking_request отправит ему запрос. До 29.09 оба
      // звучали «реальная занятость из броней», и агент до запроса не доходил.
      const keeps = await tourKeepsSchedule(Number(tour.id));
      if (keeps === false) {
        // Только по сезону (#2244, #2245): окно запроса обрезается сезоном
        // тура. Запрос целиком до сезона — показывается начало сезона, а не
        // пустота: «в ближайшие 14 дней ничего» агент пересказал бы как «дат
        // нет», хотя сезон впереди. Целиком после — следующего сезона в данных
        // нет, и это так и говорится.
        const window = tourRequestWindow(tour, today);
        let wFrom = from;
        let wTo = to;
        if (window.kind === 'season') {
          if (from > window.to) {
            return [...notes,
              `Тур "${tour.title}" (ID${tour.id}): заявки принимаются только по сезону (${windowLabel(window)}), даты с ${dayIn(from, today)} — вне сезона. `
              + 'Следующий сезон в системе не записан — не обещай даты, предложи уточнить у оператора.',
            ].join('\n');
          }
          if (to < window.from) {
            notes.push(`Тур принимает заявки только по сезону (${windowLabel(window)}) — показываю с начала сезона.`);
            wFrom = window.from;
            wTo = new Date(Date.parse(window.from) + (days - 1) * 86400000).toISOString().slice(0, 10);
          } else if (from < window.from) {
            wFrom = window.from;
          }
          if (wTo > window.to) wTo = window.to;
          if (wFrom !== from || wTo !== to) {
            if (to >= window.from) notes.push(`Окно обрезано по сезону тура (${windowLabel(window)}).`);
          }
        }
        // Сначала тело: оно дописывает в notes («число людей не распознано»),
        // и раскрыть notes раньше значило бы потерять эту оговорку.
        const body = await onRequestWindow(tour, wFrom, wTo, args.people, notes, window, today);
        return [
          ...notes, ...body,
          `Заявка оператору на странице: ${getPublicBaseUrl()}${tourPath(tour)}?date=<дата>. Данные на ${shortDate(today)} (по Камчатке).`,
        ].join('\n');
      }
      if (keeps === null) {
        return [...notes,
          `Тур "${tour.title}" (ID${tour.id}): свободных дат с ${shortDate(from)} по ${shortDate(to)} не нашёл, а проверить, ведёт ли тур расписание, не смог. `
          + 'Не утверждай, что мест нет, — предложи уточнить у оператора или повторить позже.',
        ].join('\n');
      }
      const people = parsePeople(args.people);
      if (args.people != null && args.people.trim() !== '' && people === null) {
        notes.push(`Число людей «${args.people}» не распознано (нужно 1–30) — ближайшую дату ищу без него.`);
      }
      // Отказ поиска за окном — свой третий исход внутри emptyWindowAnswer,
      // а не внешний «Занятость временно недоступна»: окно-то прочитано.
      const body = await emptyWindowAnswer(tour, from, to, today, people, cache);
      return [...notes, ...body].join('\n');
    }
    const SHOWN = 12;
    const people = parsePeople(args.people);
    if (args.people != null && args.people.trim() !== '' && people === null) {
      notes.push(`Число людей «${args.people}» не распознано (нужно 1–30) — итог не посчитан.`);
    }
    const shown = slots.slice(0, SHOWN);
    // Итог — ТЕМ ЖЕ расчётом, что у самой брони (honestTourPrice → reserveBooking):
    // правила цены тура и заполненность даты. Свой расчёт здесь разошёлся бы
    // с суммой брони, и ассистент назвал бы человеку не ту цифру (разбор UCP
    // 03.10: полная стоимость — до подтверждения). Отказ расчёта на дате —
    // «итог не посчитан», а не пропуск строки и не «от».
    const totals = people !== null && tour.base_price != null
      ? await Promise.all(shown.map(async (s) => {
          try {
            const p = await honestTourPrice({
              tourId: tour.id, tourDate: s.date,
              baseUnitPrice: Number(tour.base_price), priceUnit: tour.price_unit,
              participants: people,
              duration: { multi_day_count: tour.multi_day_count ?? null, duration_hours: tour.duration_hours ?? null },
            });
            return p.total;
          } catch (err) {
            // Группа вне ступеней цены — не сбой расчёта: оператор называет цену
            // сам. Отличать это от «итог не посчитан» обязательно: во втором
            // случае можно повторить, в первом — нет (#2246).
            if (err instanceof PriceTierMissError) return 'tier_miss' as const;
            const e = err as { code?: string; message?: string };
            console.error('[tour-availability] итог не посчитан', { tourId: tour.id, date: s.date, sqlstate: e?.code, message: e?.message });
            return null;
          }
        }))
      : null;
    const lines = shown.map((s, i) => {
      // Единица — из тура, а не «р/чел»: у многодневок цена за группу, и
      // агент, прочитавший «140 000 р/чел», называл цену с человека (29.09).
      // Цена на дату может быть переопределена, но единица у неё та же.
      const price = priceFromUnit(s.priceOverride ?? tour.base_price, tour.price_unit);
      const t = totals ? totals[i] : null;
      const total = totals
        ? (t === 'tier_miss'
            ? `; для группы из ${people} чел. цену называет оператор`
            : t != null ? `; итого за ${people} чел.: ${rub(t as number)}` : '; итог не посчитан')
        : '';
      return `- ${shortDate(s.date)} (${s.date}): свободно ${s.remaining}${price ? `, ${price}` : ''}${total}`;
    });
    const more = slots.length > SHOWN
      ? [`…и ещё ${slots.length - SHOWN} дат с местами до ${shortDate(to)} — чтобы увидеть их, сдвиньте date_from.`]
      : [];
    return [
      ...notes,
      `Тур "${tour.title}" (ID${tour.id}) — свободные даты (реальная занятость мест):`,
      ...lines,
      ...more,
      // Ссылка — полным адресом: относительная у внешнего агента никуда не
      // ведёт (проверка MCP 29.09).
      `Заявка оператору на странице: ${getPublicBaseUrl()}${tourPath(tour)}?date=<дата>. Данные на ${shortDate(today)} (по Камчатке).`,
      ...(totals
        ? ['Итог — сумма, которую посчитает заявка на эту дату и число людей (правила цены тура и заполненность даты). Трансферы и услуги из «не входит» в неё не включены.']
        : ['Итоговую сумму за группу на дату даёт этот же инструмент с параметром people.']),
    ].join('\n');
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[tour-availability] занятость не прочитана', { tourId: tour.id, sqlstate: e?.code, message: e?.message });
    return 'Занятость временно недоступна — не называй даты по памяти, предложи страницу тура.';
  }
}
