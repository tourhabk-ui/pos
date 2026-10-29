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
 * Тур по названию/ключевому слову или числовому ID — один резолвер для
 * get_tour_details, get_tour_availability, create_booking_request, handoff и
 * брони в мессенджере. Только тур на витрине (publicTourSql): черновик
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
 * длине строки — ровно то, чего правило 1в не допускает. Теперь исходов три:
 *   - `one` — лучший ранг у туров одной компании: продавец ясен, тур внутри
 *     компании — первый по правилу 1в (lib/tours/offer-order);
 *   - `ambiguous` — лучший ранг у туров двух и более компаний: инструмент,
 *     который пишет (заявка), не выбирает продавца за человека, а называет
 *     всех в порядке правила и просит номер тура;
 *   - `none` — такого тура нет.
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

/** Основы значимых слов запроса (от 4 букв), не больше пяти. */
export function tourQueryStems(q: string): string[] {
  const words = q.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i).filter((w) => w.length >= 4);
  const out: string[] = [];
  for (const w of words) {
    const stem = w.length >= 5 ? w.slice(0, Math.max(4, w.length - 2)) : w;
    if (!out.includes(stem)) out.push(stem);
  }
  return out.slice(0, 5);
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

export type TourChoice =
  | { kind: 'one'; tour: TourCandidate }
  | { kind: 'ambiguous'; candidates: TourCandidate[] }
  | { kind: 'none' };

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

/**
 * Из строк лучшего ранга — исход. Порядок кандидатов — правило 1в: тот же,
 * что у витрин, ничего не решает длина названия или цена.
 */
function choose(rows: CandidateRow[], rankOf: (r: CandidateRow) => number): TourChoice {
  if (rows.length === 0) return { kind: 'none' };
  const best = Math.min(...rows.map(rankOf));
  const top = rows.filter((r) => rankOf(r) === best).map(toCandidate);
  const ordered = orderOffersBy(top, (t) => ({ id: t.id, nearestFreeDate: t.nearest_free_date }));
  const companies = new Set(ordered.map(companyKey));
  return companies.size > 1 ? { kind: 'ambiguous', candidates: ordered } : { kind: 'one', tour: ordered[0] };
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
    const { rows } = await pool.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS}, ${TITLE_RANK_SQL} AS rank ${CANDIDATE_FROM}
          AND (ot.title ILIKE $1 OR ot.short_description ILIKE $1 OR ot.activity_type ILIKE $1 OR ot.location_name ILIKE $1)`,
      [containsPattern(q), q, startsPattern(q)],
    );
    if (rows.length > 0) return choose(rows, (r) => Number(r.rank ?? 3));
    // Фраза целиком не нашлась («Авачинский восхождение» — слова из перевода
    // запроса стоят не подряд): по основам слов; больше совпадений в
    // названии и месте — лучше ранг.
    const stems = tourQueryStems(q);
    if (stems.length < 2) return { kind: 'none' };
    const hits = stems.map((_, i) => `(CASE WHEN ot.title ILIKE $${i + 1} OR ot.location_name ILIKE $${i + 1} THEN 1 ELSE 0 END)`).join(' + ');
    const { rows: byWords } = await pool.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS}, -(${hits}) AS rank ${CANDIDATE_FROM}
          AND (${hits}) > 0`,
      stems.map((t) => containsPattern(t)),
    );
    return choose(byWords, (r) => Number(r.rank ?? 0));
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
 * Больше десяти — «и ещё N» со ссылкой на get_tours.
 */
export function candidateLines(candidates: readonly TourCandidate[], limit = CANDIDATES_SHOWN): string[] {
  const lines = candidates.slice(0, limit).map((c) => {
    const price = priceWithUnitWords(c.base_price, c.price_unit) ?? 'цена не указана';
    return `- ID${c.id} «${c.title}» — ${c.operator_name ?? 'компания не записана'} — ${price}`;
  });
  if (candidates.length > limit) lines.push(`- и ещё ${candidates.length - limit} — get_tours`);
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
