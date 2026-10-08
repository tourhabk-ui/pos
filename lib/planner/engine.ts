/**
 * TripPlanner AI Recommender v3
 * Knowledge-driven engine: distances, constraints, seasons, safety, real pricing
 */

import { callAIWithModelDirect } from '@/lib/ai/providers';
import { getModelForAgent } from '@/lib/ai/agent-models';
import type { ChatMessage } from '@/lib/ai/prompts';
import { pool } from '@/lib/db-pool';
// Зоны, активности и их сезонные окна переехали в чистый модуль без
// зависимостей (20.09) — см. его шапку. Здесь они ре-экспортируются, чтобы
// ни один прежний читатель `@/lib/planner/engine` не был тронут.
import {
  type ZoneId, type TransportType, type FitnessLevel, type ActivityConstraints,
  ZONE_NAMES, ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES, ZONE_SLEEPS_IN, sleepZoneOf,
} from '@/lib/planner/constants';
import { ZONE_GRAPH, type ZoneEdge } from '@/lib/planner/zone-graph';
import { zoneLegCost, legFits, legShortfallMessage, type ZoneLegCost } from '@/lib/planner/zone-leg';
import {
  asTripOrigin, framingDays, activeBudget as framedActiveBudget,
  arrivalDayText, departureDayText, nightIsAtHome, paysAirportTransfers,
  HOME_NIGHTS_ASSUMPTION, LOCAL_HOME_ZONE, type TripOrigin,
} from '@/lib/planner/trip-origin';
export { ZONE_GRAPH };
export type { ZoneEdge };

export {
  type ZoneId, type TransportType, type FitnessLevel, type ActivityConstraints,
  ZONE_NAMES, ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES,
};
import {
  createPlannerCache, fetchRealToursForZone, fetchAvailabilityForTour,
  fetchZoneCapacity, fetchContingencyAlternatives, fetchReviewSignals,
  fetchActivitiesBookableInMonth, fetchSelfSafety,
  type PlannerCache, type RealTour,
} from '@/lib/planner/data';
import {
  activitySelfBlocker, routeSelfBlocker, fitRestDays, restSpacing, SELF_SAFETY_UNKNOWN,
  type TravelStyle, type PreferenceNote, type TripPreferences,
} from '@/lib/planner/travel-style';
import {
  fetchForecastDays, tripForecastWindow, computeQualityScore, assessHealthCompatibility,
} from '@/lib/planner/intelligence';
import { lodgingIncluded } from '@/lib/planner/lodging-included';
import { tourDaySpan } from '@/lib/planner/tour-span';
import { activityMode, type ActivityMode } from '@/lib/planner/day-mode';
import { rankByLoad, firstOverLimit, overLimitText, dateOfTripDay, tripCalendarDays, type PlaceLoad } from '@/lib/planner/flow-balance';
import { fetchCandidateLoads, fetchTourLoads } from '@/lib/planner/place-load';
import { UNDATED_ALERT_HORIZON_DAYS } from '@/lib/safety/alert-horizon';

// ─── Public types ────────────────────────────────────────────────────────────

export type BudgetTier = 'economy' | 'comfort' | 'premium';
export type DayType = 'arrival' | 'activity' | 'travel' | 'rest' | 'buffer' | 'departure';

export interface TripProfile {
  interests: string[];
  arrivalDate?: string;
  departureDate?: string;
  flightArrivalTime?: string;
  flightDepartureTime?: string;
  adults: number;
  children: number[];           // ages array, e.g. [8, 12]
  fitnessLevel: FitnessLevel;
  budgetTier: BudgetTier;
  seasickness?: boolean;        // motion sickness — avoid boat activities
  riskMode?: 'safe_only' | 'adventure' | 'available'; // default: safe_only
  healthNotes?: string;         // free text: injuries, allergies, conditions
  mobilityLevel?: 'full' | 'limited' | 'wheelchair';
  /**
   * Стиль поездки (владелец 26.09). Нет или `mixed` — прежнее поведение
   * движка без единого отличия; правила `self`/`operator` — в
   * lib/planner/travel-style.
   */
  travelStyle?: TravelStyle;
  /** Сколько дней отдыха поставить; режется сроком поездки. */
  restDays?: number;
  /**
   * Прилетает человек или живёт в крае (владелец 27.09). Нет или `visitor` —
   * прежнее поведение движка без единого отличия; правило — в
   * lib/planner/trip-origin.
   */
  tripOrigin?: TripOrigin;
}

/**
 * Отказ чтения занятости тура — null («не знаю»), но не молча: имя тура и
 * SQLSTATE уходят в лог (§4.0). null дальше читается как `unread`, а не как
 * «мест нет».
 */
function availabilityUnread(tourId: string) {
  return (err: unknown): null => {
    const e = err as { code?: string; message?: string } | undefined;
    console.error('[planner] занятость тура не прочитана', { tourId, sqlstate: e?.code, message: e?.message });
    return null;
  };
}

export interface DayPlan {
  day: number;
  type: DayType;
  zone: ZoneId;
  title: string;
  description: string;
  activityType: string;
  priceFrom: number;
  priceTo: number;
  coords: [number, number];
  defaultTransport: TransportType;
  allowedTransports: TransportType[];
  difficulty: 'easy' | 'moderate' | 'hard';
  childFriendly: boolean;
  minChildAge: number;
  dayWarnings: string[];
  /**
   * Род активного дня: тур оператора, самостоятельный выход или «на выбор»
   * (см. lib/planner/day-mode). Только у `type: 'activity'`; у прилёта,
   * отдыха и резерва рода нет — их род и есть `type`.
   */
  activityMode?: ActivityMode;
  // Reality-aware fields (all optional for backward compat)
  realTour?: {
    tourId: string;
    operatorName: string;
    operatorSlug: string;
    operatorRating: number;
    tourRating: number | null;
    reviewCount: number;
    verified: boolean;
    maxParticipants: number;
    weatherDependent: boolean;
    durationHours: number | null;
    /**
     * Включено ли проживание в тур: `true` / `false` / `null` — не знаем.
     * Ночь такого дня не оплачивается отдельно (см. calculatePriceBreakdown).
     */
    lodgingIncluded: boolean | null;
  };
  realPrice?: number;
  availableDate?: string;
  slotsRemaining?: number;
  /**
   * Чем кончилось чтение занятости тура дня (только у дня с `realTour`):
   * `open` — свободная дата есть (`availableDate`), `none` — прочитано, в окне
   * поездки свободных дат нет, `unread` — прочитать не смогли. Нет поля —
   * занятость не читалась (продолжение многодневного тура, нет дат поездки).
   * Без него «дат нет» и «не смогли проверить» снаружи неотличимы (§4.0, #2241).
   */
  availability?: 'open' | 'none' | 'unread';
  capacityWarning?: string;
  weatherForecast?: {
    tempMax: number;
    tempMin: number;
    precipMm: number;
    windKmh: number;
    code: number;
    description: string;
  };
  alternatives?: Array<{
    tourId: string;
    title: string;
    price: number;
    discountPercent: number;
  }>;
  qualityScore?: number;
  reasoning?: string; // почему именно этот день/активность рекомендуется данному туристу
}

export interface TripWarning {
  /**
   * `zone_days` — про арифметику календаря: дальняя зона не влезла связкой
   * (переезд + день там + возвращение) либо план кончился не в той зоне.
   * Заведён 27.09 вместе с производителем, иначе это был бы объявленный тип
   * без источника (§10.09).
   *
   * `home_nights` — про допущение в счёте: у местного ночи в Авачинской зоне
   * не посчитаны, потому что план считает их ночами у себя дома. Адреса
   * платформа не знает, поэтому допущение говорится вслух, а не прячется в
   * цифре (§4.0).
   */
  type: 'permit' | 'season' | 'safety' | 'children' | 'fitness' | 'duration' | 'weather' | 'license' | 'seasickness' | 'crowd' | 'mchs' | 'zone_days' | 'home_nights';
  severity: 'critical' | 'important' | 'info';
  message: string;
}

export interface PriceBreakdown {
  activities: [number, number];
  accommodation: [number, number];
  transport: [number, number];
  perPersonTotal: [number, number];
}

interface ZoneRecommendation {
  zone: ZoneId;
  score: number;
  reason: string;
  bestMonths: number[];
  /**
   * Занятость зоны на даты поездки, 0-100. `null` — НЕ ИЗМЕРЕНА: слотов на
   * эти даты нет вовсе либо запрос не выполнился. Ноль значит «свободно» и
   * только это.
   */
  crowdScore?: number | null;
}

export interface TripRecommendation {
  zones: ZoneRecommendation[];
  days: DayPlan[];
  warnings: TripWarning[];
  priceBreakdown: PriceBreakdown;
  itinerary: string;
  /**
   * Активности, открытые КАТАЛОГОМ на месяц поездки (слоты в продаже), даже
   * если зашитая таблица считает их закрытыми. `null` — каталог спросить не
   * вышло.
   *
   * Отдаётся наружу, чтобы отказ Кузьмича и план судили сезон ОДНИМ ответом.
   * Иначе план соберёт рыбалку в октябре, а отказ в соседней ветке скажет,
   * что в октябре рыбалка не сезон, — два голоса об одном (§10.09).
   */
  catalogueOpen: string[] | null;
  /**
   * Что человек попросил стилем и днями отдыха и что из этого вышло.
   * Есть только когда просьба была (стиль или дни отдыха переданы): без неё
   * ответ движка прежний.
   */
  preferences?: TripPreferences;
}

// ─── Knowledge base ──────────────────────────────────────────────────────────

const PKC_COORDS: [number, number] = [53.01, 158.65];


export const ZONE_COORDS: Record<ZoneId, [number, number]> = {
  avachinsky: [53.25, 158.75],
  eastern:    [54.80, 160.50],
  northern:   [54.50, 160.27],
  western:    [52.50, 156.50],
};

const ZONE_BEST_MONTHS: Record<ZoneId, number[]> = {
  avachinsky: [6, 7, 8, 9],
  western:    [5, 6, 7, 8, 9],
  eastern:    [7, 8, 9],
  northern:   [6, 7, 8, 9, 10],
};

// ── Zone transport constraints ──────────────────────────────────────────────

export const ZONE_ALLOWED_TRANSPORT: Record<ZoneId, TransportType[]> = {
  avachinsky: ['walking', 'jeep', 'helicopter'],
  western:    ['jeep', 'boat', 'helicopter'],
  eastern:    ['jeep', 'helicopter', 'boat'],
  northern:   ['helicopter'],
};

// ── Activity constraints ─────────────────────────────────────────────────────




const INTEREST_TO_ZONES: Record<string, ZoneId[]> = {
  volcano:    ['avachinsky'],
  fishing:    ['western', 'avachinsky'],
  bears:      ['eastern'],
  helicopter: ['avachinsky', 'northern'],
  thermal:    ['avachinsky'],
  trekking:   ['avachinsky', 'eastern'],
  snowmobile: ['avachinsky', 'western'],
  sea:        ['avachinsky', 'eastern', 'western'],
  hot_spring: ['avachinsky'],
  geyser:     ['northern'],
  mountain:   ['avachinsky'],
  river:      ['western', 'avachinsky'],
  boat_trip:  ['avachinsky', 'western', 'eastern'],
};

// ── Accommodation by zone ───────────────────────────────────────────────────

interface AccommodationInfo {
  types: string[];
  pricePerNight: [number, number, number]; // [economy, comfort, premium]
  note: string;
  /**
   * Где турист НОЧУЕТ, если в этой зоне не ночуют.
   *
   * Заведено 20.09. У северной зоны стояло `pricePerNight: [0, 0, 0]` с
   * припиской «Однодневная экскурсия, ночёвка в Авачинской зоне» — то есть
   * факт был записан прозой, а код читал из него только ноль. Ночь,
   * которую человек проводит в Петропавловске, не считалась НИГДЕ: смета
   * занижалась ровно на неё.
   *
   * Тот же род дефекта, что двойной счёт ночи на базе, только в другую
   * сторону — и оба от того, что о ночёвке судили не по данным.
   */
  sleepsIn?: ZoneId;
}

const ZONE_ACCOMMODATION: Record<ZoneId, AccommodationInfo> = {
  avachinsky: {
    types: ['гостиница', 'апартаменты', 'хостел'],
    pricePerNight: [3000, 7000, 15000],
    note: 'Петропавловск / Паратунка — широкий выбор',
  },
  western: {
    types: ['рыболовная база', 'палатка'],
    pricePerNight: [8000, 20000, 40000],
    note: 'Удалённые базы, питание включено',
  },
  eastern: {
    types: ['эко-лодж', 'палатка', 'модуль'],
    pricePerNight: [10000, 25000, 50000],
    note: 'Ограниченное размещение, бронь заранее',
  },
  northern: {
    types: [],
    pricePerNight: [0, 0, 0],
    note: 'Однодневная экскурсия, ночёвка в Авачинской зоне',
    // Приписка выше теперь не только для чтения: ночь считается по той
    // зоне, где её реально проводят.
    sleepsIn: ZONE_SLEEPS_IN.northern,
  },
};

// ── Permits by zone ──────────────────────────────────────────────────────────

interface PermitInfo {
  type: 'reserve' | 'border' | 'license';
  name: string;
  advanceDays: number;
  note: string;
}

const ZONE_PERMITS: Partial<Record<ZoneId, PermitInfo[]>> = {
  northern: [
    { type: 'reserve', name: 'Кроноцкий государственный заповедник', advanceDays: 30,
      note: 'Бронирование через kronoki.ru — Долина гейзеров, кальдера Узон' },
  ],
  eastern: [
    { type: 'reserve', name: 'Южно-Камчатский федеральный заказник', advanceDays: 14,
      note: 'Для посещения Курильского озера' },
    { type: 'border', name: 'Пограничная зона ФСБ', advanceDays: 30,
      note: 'Мыс Лопатка и части восточного побережья — заявка через Госуслуги или ФСБ' },
  ],
};

// ─── Database helpers ────────────────────────────────────────────────────────

interface RouteFromDB {
  id: string;
  title: string;
  lat: number;
  lng: number;
  zone: string;
  activity_type: string;
  location_type: string;
}

/**
 * Маршруты зоны под активность. `null` — спросить не вышло (см. шапку
 * `fetchRealToursForZone`): «не смогли» не равно «маршрутов нет».
 */
async function fetchRoutesForZone(zone: ZoneId, activityType: string, limit: number = 5): Promise<RouteFromDB[] | null> {
  try {
    const { rows } = await pool.query<RouteFromDB>(
      `SELECT id, title, lat, lng, zone, activity_type, location_type
       FROM agent_route_knowledge
       WHERE zone = $1 AND activity_type = $2 AND is_visible = TRUE
         AND lat IS NOT NULL AND lng IS NOT NULL
       ORDER BY RANDOM() LIMIT $3`,
      [zone, activityType, limit]
    );
    return rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[planner] маршруты зоны не прочитались (${zone}/${activityType}):`, message);
    return null;
  }
}

// ─── Crowd load ───────────────────────────────────────────────────────────────

interface CrowdRow {
  total_departures: string;
  booked_ratio: string;
}

/**
 * Returns a crowd score 0-100 for a date range.
 * Считает по живому календарю tour_availability + реальным броням
 * (v_tour_daily_occupancy). Раньше считал по tour_departures — там счётчик
 * booked_slots никогда не заполнялся, и ratio всегда был 0 (эвристика
 * вырождалась в сезонный fallback).
 * Higher score = more crowded. Affects zone scoring.
 */
async function fetchCrowdLoad(arrivalDate?: string, departureDate?: string): Promise<number> {
  if (!arrivalDate || !departureDate) {
    // No dates: estimate from season (July-August = peak)
    const month = new Date().getMonth() + 1;
    if ([7, 8].includes(month)) return 75;
    if ([6, 9].includes(month)) return 50;
    return 20;
  }
  try {
    const { rows } = await pool.query<CrowdRow>(
      `SELECT
         COUNT(*)::text                                                          AS total_departures,
         ROUND(
           COALESCE(
             SUM(COALESCE(occ.occupied, 0))::numeric / NULLIF(SUM(ta.available_slots), 0) * 100,
             0
           )
         )::text                                                                AS booked_ratio
       FROM tour_availability ta
       LEFT JOIN v_tour_daily_occupancy occ
         ON occ.operator_tour_id = ta.operator_tour_id AND occ.date = ta.date
       WHERE ta.is_cancelled = FALSE
         AND ta.deleted_at IS NULL
         AND ta.date BETWEEN $1::date AND $2::date`,
      [arrivalDate, departureDate]
    );
    const row = rows[0];
    if (!row) return 20;
    const ratio = parseFloat(row.booked_ratio) || 0;
    const count = parseInt(row.total_departures, 10) || 0;
    // Weighted: bookings ratio + volume bonus
    return Math.min(100, Math.round(ratio * 0.7 + Math.min(count * 2, 30)));
  } catch {
    return 20;
  }
}

// ─── Safety alerts ────────────────────────────────────────────────────────────

export interface SafetyAlert {
  id: string;
  zone: string;
  severity: 'critical' | 'important' | 'info';
  title: string;
  message: string;
  source: string;
}

interface SafetyAlertRow {
  id: string;
  zone: string;
  severity: string;
  title: string;
  message: string;
  source: string;
}

/**
 * Активные предупреждения безопасности из БД.
 *
 * Пустой список при ОТКАЗЕ запроса — самая дорогая подмена на платформе:
 * планировщик подмешивает эти предупреждения в рекомендации, и «не смог
 * прочитать» превращается в «в этой зоне всё спокойно». Человек получает
 * маршрут туда, откуда, возможно, сейчас не выехать.
 *
 * Отказ по-прежнему не роняет планирование — но молчать о нём нельзя: имя
 * проверки и SQLSTATE идут в лог (§4.0). 23.08 выяснилось, что таблицу
 * вдобавок никто не ЗАПОЛНЯЛ: приёмник появился только тогда
 * (/api/cron/safety-alert), а до него слой предупреждений был пуст и
 * выглядел работающим.
 */
/** Число одно на платформу — lib/safety/alert-horizon. */
export { UNDATED_ALERT_HORIZON_DAYS };

async function fetchSafetyAlerts(arrivalDate?: string, departureDate?: string): Promise<SafetyAlert[]> {
  try {
    const params: string[] = [];
    let dateFilter = '';
    if (arrivalDate && departureDate) {
      params.push(arrivalDate, departureDate, String(UNDATED_ALERT_HORIZON_DAYS));
      // Без срока окончания тревога — снимок обстановки на день публикации,
      // а не прогноз. «Проезд перекрыт» от 23.08 выводился в плане на июль
      // 2027 (аудит MCP 29.09). Такая тревога идёт только в план поездки,
      // начинающейся в ближайшие UNDATED_ALERT_HORIZON_DAYS дней; у датированной —
      // её собственный срок, как прежде.
      //
      // И только пока сама не устарела (03.10): та же сводка 23.08 в октябре
      // проходила это условие — поездка «в ближайшие две недели» есть всегда,
      // а возраст тревоги не спрашивался вовсе.
      dateFilter = `AND (active_until >= $1::date
                         OR (active_until IS NULL
                             AND $1::date <= CURRENT_DATE + $3::int
                             AND active_from > NOW() - make_interval(days => $3::int)))
                    AND active_from <= $2::date`;
    }
    const { rows } = await pool.query<SafetyAlertRow>(
      `SELECT id, zone, severity, title, message, source
       FROM safety_alerts
       WHERE is_active = TRUE ${dateFilter}
       ORDER BY severity = 'critical' DESC, created_at DESC
       LIMIT 10`,
      params
    );
    return rows as SafetyAlert[];
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'unknown';
    console.error(
      `[planner] предупреждения безопасности не прочитаны, SQLSTATE ${code} — ` +
      'рекомендации строятся БЕЗ них',
    );
    return [];
  }
}

/**
 * Имя активности и уровень подготовки словами — для текста предупреждений.
 * До 29.09 в них стоял ключ движка: «volcano: требуется уровень "active", у
 * вас "moderate"» уходило туристу и агентам MCP как есть (аудит MCP 29.09).
 * Словарь активностей один (ACTIVITY_NAMES), второй перевод разошёлся бы.
 */
function activityLabel(interest: string): string {
  const name = ACTIVITY_NAMES[interest] ?? interest;
  return name.charAt(0).toLocaleUpperCase('ru-RU') + name.slice(1);
}

const FITNESS_WORDS: Record<FitnessLevel, string> = {
  beginner: 'начальная',
  moderate: 'средняя',
  active: 'хорошая',
};

// ─── Core engine ─────────────────────────────────────────────────────────────

/**
 * В сезоне ли активность в этом месяце.
 *
 * Два свидетеля, и они не равнозначны:
 *   — таблица движка (`ACTIVITY_CONSTRAINTS.months`) — ПОЛ. Она несёт не
 *     только коммерцию, но и безопасность: «снег на тропах тает к середине
 *     июня». Снимать её нельзя;
 *   — каталог (`catalogueOpen`) — открытые слоты этого месяца. Это ДЕЙСТВИЕ
 *     оператора, а не его описание, и оно окно только расширяет.
 *
 * Замер 20.09: семь живых туров из восьми рыболовные, один — «Осенняя
 * рыбалка (октябрь-ноябрь)», а `fishing.months` = [6,7,8,9]. Пол один, без
 * каталога, отказывал туристу в том, что оператор продаёт.
 *
 * `catalogueOpen === null` — каталог спросить не вышло. Тогда действует один
 * пол, и вызывающий обязан сказать об этом словами.
 */
function inSeason(interest: string, month: number, catalogueOpen: Set<string> | null): boolean {
  const c = ACTIVITY_CONSTRAINTS[interest];
  if (!c) return false;
  if (c.months.includes(month)) return true;
  return catalogueOpen?.has(interest) ?? false;
}

/** Активности, открытые ТОЛЬКО каталогом: расхождение, которое надо назвать. */
function openedByCatalogueOnly(
  interests: string[], month: number, catalogueOpen: Set<string> | null,
): string[] {
  if (!catalogueOpen) return [];
  return interests.filter(
    (i) => ACTIVITY_CONSTRAINTS[i] && !ACTIVITY_CONSTRAINTS[i].months.includes(month) && catalogueOpen.has(i),
  );
}

function getMonth(profile: TripProfile): number {
  return profile.arrivalDate
    ? new Date(profile.arrivalDate).getMonth() + 1
    : new Date().getMonth() + 1;
}

/** «1 день / 2 дня / 5 дней» — счёт в предупреждении читает человек. */
function pluralDays(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'дней';
  switch (n % 10) {
    case 1: return 'день';
    case 2: case 3: case 4: return 'дня';
    default: return 'дней';
  }
}

/**
 * Сколько КАЛЕНДАРНЫХ ДНЕЙ в поездке, считая и первый, и последний.
 *
 * ── Что было до 27.09 ─────────────────────────────────────────────────────
 *
 * Возвращалась разница дат, то есть число НОЧЕЙ, а называлось днями. Прогон
 * на 10-17 июля давал семь дней, и последним днём плана — днём с подписью
 * «Сборы утром. Трансфер в аэропорт, вылет днём» — оказывалось 16 июля. Рейс
 * у человека 17-го.
 *
 * Цена этой ошибки считается по-разному в трёх местах:
 *
 *   • последняя строка плана читается как день рейса и указывала НЕ НА ТУ
 *     дату — ровно тот же сорт неправды, что и день прилёта в плане жителя
 *     края;
 *   • последний календарный день поездки не планировался вовсе: человек
 *     терял один день из каждой поездки;
 *   • `trip_days` уходит в лид оператору (`source_data`), и оператор читал
 *     «7 дней» о восьмидневной поездке.
 *
 * Равные даты — это ОДИН день, а не ноль: житель края выезжает утром и
 * возвращается вечером, и такая поездка законна (решение владельца 27.09 про
 * местных туристов).
 */
function getTripDays(profile: TripProfile): number {
  if (!profile.arrivalDate || !profile.departureDate) return 0;
  return tripCalendarDays(profile.arrivalDate, profile.departureDate);
}

function hasYoungChildren(profile: TripProfile): boolean {
  return profile.children.some(age => age < 10);
}

function youngestChild(profile: TripProfile): number | null {
  if (profile.children.length === 0) return null;
  return Math.min(...profile.children);
}

function groupSize(profile: TripProfile): number {
  return profile.adults + profile.children.length;
}

function budgetIndex(tier: BudgetTier): 0 | 1 | 2 {
  return tier === 'economy' ? 0 : tier === 'comfort' ? 1 : 2;
}

// ── Warnings collector ──────────────────────────────────────────────────────

/**
 * Предупреждения, выведенные из данных о здоровье (подвижность, заметки о
 * здоровье). Сведения о здоровье — особая категория ПД; модели у нас
 * зарубежные, значит в промпт они не уходят ни текстом, ни пересказом
 * (решение владельца 26.09, §8). Человеку они показываются как прежде —
 * метка живёт вне объекта и в ответ API не попадает.
 */
const HEALTH_DERIVED = new WeakSet<TripWarning>();

function collectWarnings(
  profile: TripProfile,
  zones: ZoneRecommendation[],
  tripDays: number,
  crowdLoad: number = 0,
  alerts: SafetyAlert[] = [],
  /** Открытое каталогом на этот месяц; `null` — каталог спросить не вышло. */
  catalogueOpen: Set<string> | null,
  /**
   * Зоны ГОТОВОГО плана. Требования (разрешения, удалённость) относятся к ним,
   * а не к зонам-кандидатам: человек не должен читать «нужна погранзона ФСБ за
   * 30 дней» про зону, куда поездка не идёт.
   */
  plannedZones: Set<ZoneId>,
): TripWarning[] {
  const warnings: TripWarning[] = [];
  const month = getMonth(profile);
  const youngest = youngestChild(profile);

  // ── МЧС / safety alerts ───────────────────────────────────────────────────
  for (const alert of alerts) {
    const zoneMatch = alert.zone === 'all' || zones.some(z => z.zone === alert.zone);
    if (zoneMatch) {
      warnings.push({
        type: 'mchs',
        severity: alert.severity as TripWarning['severity'],
        message: `[${alert.source}] ${alert.title}: ${alert.message}`,
      });
    }
  }

  // ── Seasickness ───────────────────────────────────────────────────────────
  if (profile.seasickness) {
    const boatRequired = profile.interests.filter(i => ACTIVITY_CONSTRAINTS[i]?.requiredTransport === 'boat');
    const boatOptional = profile.interests.filter(i => {
      const c = ACTIVITY_CONSTRAINTS[i];
      return c && c.allowedTransports.includes('boat') && c.requiredTransport !== 'boat';
    });

    if (boatRequired.length > 0) {
      warnings.push({
        type: 'seasickness', severity: 'critical',
        message: `Морская болезнь: "${boatRequired.join(', ')}" требует катера. Прибрежные прогулки и наблюдение с берега заменят морские выходы. Уточните с оператором.`,
      });
    }
    if (boatOptional.length > 0) {
      warnings.push({
        type: 'seasickness', severity: 'important',
        message: `Морская болезнь учтена: рыбалка и речные маршруты скорректированы на береговые и джип-варианты.`,
      });
    }
    // If significant sea activities
    if (profile.interests.some(i => ['boat_trip', 'sea'].includes(i))) {
      warnings.push({
        type: 'seasickness', severity: 'important',
        message: 'Авачинская бухта и побережье доступны без морских выходов: пешие маршруты, смотровые площадки, маяки.',
      });
    }
  }

  // ── Crowd load ────────────────────────────────────────────────────────────
  if (crowdLoad > 70) {
    warnings.push({
      type: 'crowd', severity: 'important',
      message: `Высокий сезон: популярные локации загружены на ~${crowdLoad}%. Рекомендуем бронировать гидов и трансфер за 2-3 недели. Некоторые дни скорректированы на менее популярные маршруты.`,
    });
  } else if (crowdLoad > 50) {
    warnings.push({
      type: 'crowd', severity: 'info',
      message: `Умеренная загрузка (~${crowdLoad}%). Брони лучше подтвердить за 1 неделю до выезда.`,
    });
  }

  // Min trip duration
  //
  // Довод про короткую поездку у приезжего и у местного РАЗНЫЙ, а не один с
  // поправкой. Приезжему мало пяти дней, потому что два из них съедает
  // самолёт и джетлаг; местному эти два дня никто не отнимает, и «мало» у
  // него значит другое — погода на Камчатке переносит выход, и запаса дней
  // нет. Читать про «перелёт 8-9 часов из Москвы» жителю Петропавловска —
  // ровно тот же сорт неправды, что день прилёта в его плане (27.09).
  // Порог в КАЛЕНДАРНЫХ днях. Прежние `< 5` считались по ночам, то есть
  // срабатывали на поездке короче шести календарных дней; `< 6` — тот же
  // рубеж в новых единицах, а не новое решение о длине поездки.
  if (tripDays > 0 && tripDays < 6) {
    warnings.push({
      type: 'duration', severity: 'important',
      message: asTripOrigin(profile.tripOrigin) === 'local'
        ? `${tripDays} ${pluralDays(tripDays)} — короткая поездка: погода на Камчатке переносит выходы, и запасного дня в плане нет. Если выход сорвётся, заменить его будет нечем.`
        : `${tripDays} дня — очень мало для Камчатки. Перелёт 8-9 часов из Москвы + джетлаг (UTC+12). Рекомендуем минимум 7 дней.`,
    });
  }

  // Season warnings per activity
  for (const interest of profile.interests) {
    const c = ACTIVITY_CONSTRAINTS[interest];
    if (!c) continue;
    if (!inSeason(interest, month, catalogueOpen)) {
      warnings.push({
        type: 'season', severity: 'critical',
        message: `${activityLabel(interest)}: недоступно в выбранный период. ${c.seasonNote ?? ''}`.trim(),
      });
    }
  }

  // Children constraints
  if (youngest !== null) {
    for (const interest of profile.interests) {
      const c = ACTIVITY_CONSTRAINTS[interest];
      if (!c) continue;
      if (youngest < c.minChildAge) {
        const alt = c.childAlternative ? ` Альтернатива: ${c.childAlternative}` : '';
        warnings.push({
          type: 'children', severity: 'important',
          message: `${activityLabel(interest)}: минимальный возраст ${c.minChildAge} лет, ребёнку ${youngest}.${alt}`,
        });
      }
    }
  }

  // Fitness
  for (const interest of profile.interests) {
    const c = ACTIVITY_CONSTRAINTS[interest];
    if (!c) continue;
    const levels: FitnessLevel[] = ['beginner', 'moderate', 'active'];
    if (levels.indexOf(c.fitnessRequired) > levels.indexOf(profile.fitnessLevel)) {
      warnings.push({
        type: 'fitness', severity: 'important',
        message: `${activityLabel(interest)}: нужна ${FITNESS_WORDS[c.fitnessRequired]} подготовка, у вас указана ${FITNESS_WORDS[profile.fitnessLevel]}. ${c.safetyNotes?.[0] ?? ''}`.trim(),
      });
    }
  }

  // ── Разрешения: критично — только для зон ПЛАНА ──
  for (const zone of plannedZones) {
    const permits = ZONE_PERMITS[zone];
    if (!permits) continue;
    for (const p of permits) {
      warnings.push({
        type: 'permit', severity: 'critical',
        message: `${ZONE_NAMES[zone]}: требуется ${p.name}. Оформление за ${p.advanceDays} дней. ${p.note}`,
      });
    }
  }

  // ── Требования зон, которые в план НЕ вошли ──
  //
  // Решение владельца 27.09: показать, но без веса «critical» и одной справочной
  // строкой. Совсем молчать нельзя: человек может добавить такую зону руками
  // или спросить оператора, и тогда тридцать дней на погранзону — новость,
  // которую лучше узнать сейчас. Но и пугать требованиями к поездке, которой
  // нет, нельзя: критическое предупреждение не по делу обесценивает все
  // остальные.
  const notPlanned = [...new Set(zones.map((z) => z.zone))].filter((z) => !plannedZones.has(z));
  const extraPermits = notPlanned.flatMap((zone) =>
    (ZONE_PERMITS[zone] ?? []).map((p) => `${ZONE_NAMES[zone]} — ${p.name} (за ${p.advanceDays} дней)`),
  );
  if (extraPermits.length > 0) {
    warnings.push({
      type: 'permit', severity: 'info',
      message: `Если захотите добавить зоны, которых нет в этом плане, им нужны свои разрешения: ${extraPermits.join('; ')}.`,
    });
  }

  // Fishing license
  if (profile.interests.includes('fishing')) {
    warnings.push({
      type: 'license', severity: 'important',
      message: 'Рыбалка: требуется рыболовная путёвка. Правила зависят от реки и вида рыбы. Оформляет оператор.',
    });
  }

  // Helicopter weather buffer
  const heliActivities = profile.interests.filter(i => {
    const c = ACTIVITY_CONSTRAINTS[i];
    return c?.requiredTransport === 'helicopter';
  });
  if (heliActivities.length > 0) {
    warnings.push({
      type: 'weather', severity: 'important',
      message: `Вертолётные экскурсии (${heliActivities.join(', ')}): 30-50% рейсов отменяют из-за тумана. В план добавлен запасной день.`,
    });
  }

  // Safety for remote areas
  // Удалённость — свойство зон ПЛАНА: предупреждать об отсутствии связи там,
  // куда человек не едет, значит приучать пропускать это предупреждение.
  const remoteZones = [...plannedZones].filter(z => z !== 'avachinsky');
  if (remoteZones.length > 0) {
    warnings.push({
      type: 'safety', severity: 'info',
      message: 'Удалённые зоны: нет сотовой связи, нет дорог. Рекомендуется спутниковый телефон и опытный гид.',
    });
  }

  // Bear safety
  if (profile.interests.some(i => ['bears', 'fishing', 'trekking'].includes(i))) {
    warnings.push({
      type: 'safety', severity: 'info',
      message: 'Территория медведей. Гид с фальшфейером обязателен. Перцовый спрей рекомендован.',
    });
  }

  // Health / mobility warnings
  //
  // Выведены из данных о здоровье — и потому помечаются: в промпт модели
  // (зарубежной, §8 / 152-ФЗ) они не уходят. См. HEALTH_DERIVED.
  if (profile.mobilityLevel === 'wheelchair') {
    const w: TripWarning = {
      type: 'safety', severity: 'critical',
      message: 'Камчатка имеет крайне ограниченную безбарьерную инфраструктуру. Доступные варианты: термальные источники Паратунки, обзорные вертолётные экскурсии.',
    };
    HEALTH_DERIVED.add(w);
    warnings.push(w);
  } else if (profile.mobilityLevel === 'limited') {
    const w: TripWarning = {
      type: 'fitness', severity: 'important',
      message: 'Ограниченная подвижность: маршруты адаптированы, исключены многочасовые переходы и крутые подъёмы.',
    };
    HEALTH_DERIVED.add(w);
    warnings.push(w);
  }

  // Large group advisory
  const gs = groupSize(profile);
  if (gs >= 8) {
    warnings.push({
      type: 'season', severity: 'important',
      message: `Группа ${gs} человек — ограниченная вместимость на многих турах. Рекомендуем бронировать за 14+ дней.`,
    });
  }

  return warnings;
}

// ── Zone scoring ─────────────────────────────────────────────────────────────

async function scoreZones(
  profile: TripProfile,
  cache: PlannerCache,
  /** Открытое каталогом на этот месяц; `null` — каталог спросить не вышло. */
  catalogueOpen: Set<string> | null,
): Promise<ZoneRecommendation[]> {
  const month = getMonth(profile);
  const scores: Record<string, number> = {};
  /** Занятость зоны на даты поездки; `null` — не измерена (§4.0). */
  const crowd: Partial<Record<ZoneId, number | null>> = {};

  for (const interest of profile.interests) {
    const c = ACTIVITY_CONSTRAINTS[interest];
    if (!c) continue;
    if (!inSeason(interest, month, catalogueOpen)) continue;
    for (const zone of c.bestZones) {
      scores[zone] = (scores[zone] ?? 0) + 25;
    }
  }

  // Penalize off-season zones
  for (const [zone, months] of Object.entries(ZONE_BEST_MONTHS)) {
    if (!months.includes(month)) {
      scores[zone] = Math.max(0, (scores[zone] ?? 0) - 15);
    }
  }

  // If children < 8 and northern is scored, reduce (geyser minAge=8)
  const youngest = youngestChild(profile);
  if (youngest !== null && youngest < 8 && scores['northern']) {
    scores['northern'] = Math.max(0, scores['northern'] - 20);
  }

  // Seasickness: penalize zones with mandatory boat access
  if (profile.seasickness) {
    scores['western'] = Math.max(0, (scores['western'] ?? 0) - 15);
  }

  // Reality boosts: prefer zones with real operator tours + good ratings
  for (const zone of Object.keys(scores) as ZoneId[]) {
    if ((scores[zone] ?? 0) <= 0) continue;
    const primaryInterest = profile.interests[0] ?? 'trekking';
    const realTours = await fetchRealToursForZone(zone, primaryInterest, 3, cache);
    // `null` — не смогли спросить. Ни надбавки, ни штрафа: зона не становится
    // хуже оттого, что про неё не удалось узнать. Трактовать отказ как
    // «туров нет» значило бы уводить план из зоны по выдуманной причине.
    if (realTours && realTours.length > 0) {
      scores[zone] = (scores[zone] ?? 0) + 10;
      const avgRating = realTours.reduce((s, t) => s + t.operatorRating, 0) / realTours.length;
      if (avgRating >= 4.0) {
        scores[zone] = (scores[zone] ?? 0) + 5;
      }
    }
    // Capacity check: penalize overloaded zones.
    //
    // Занятость запоминается и уходит наружу меткой зоны (`crowdScore`):
    // до 27.09 она считалась здесь, штрафовала оценку и терялась, а на экран
    // шёл захардкоженный ноль — метка «загружено / умеренно» не могла
    // зажечься ни при какой заполненности (§10.09: потребитель на экране был,
    // производителя не было).
    //
    // `null` — не измерено, и штрафовать за него нельзя: «слотов на эти даты
    // нет» не то же, что «зона переполнена».
    if (profile.arrivalDate && profile.departureDate) {
      const cap = await fetchZoneCapacity(zone, profile.arrivalDate, profile.departureDate, cache);
      crowd[zone] = cap.utilizationPercent;
      if (cap.utilizationPercent !== null && cap.utilizationPercent > 80) {
        scores[zone] = Math.max(0, (scores[zone] ?? 0) - 10);
      }
    }
  }

  return Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([zone, score]) => ({
      zone: zone as ZoneId,
      score: Math.min(100, score),
      reason: `${profile.interests.filter(i => ACTIVITY_CONSTRAINTS[i]?.bestZones.includes(zone as ZoneId)).join(', ')}`,
      bestMonths: ZONE_BEST_MONTHS[zone as ZoneId] ?? [],
      // Настоящая занятость зоны из реальных броней; `null` — не измерена.
      crowdScore: crowd[zone as ZoneId] ?? null,
    }));
}

// ── Day plan generator ──────────────────────────────────────────────────────

/**
 * Дни плана и то, чего мы про них НЕ узнали.
 *
 * `unchecked` — пары «зона / активность», по которым запрос к каталогу не
 * выполнился. Без этого списка недобор дней объяснялся бы сезоном всегда, в
 * том числе когда причина другая и неизвестная (§4.0).
 */
interface DayPlanResult {
  days: DayPlan[];
  unchecked: string[];
  /** Туры, чья длительность не заполнена: поставлены одним днём. */
  spanUnknown: string[];
  /** Туры, не поместившиеся в срок: пропущены целиком, а не урезаны. */
  tooLong: string[];
  /** Места, не предложенные из-за природоохранного лимита на даты поездки. */
  overLimit: string[];
  /** Как исполнены стиль и дни отдыха; пусто, если просьбы не было. */
  preferenceNotes: PreferenceNote[];
  /** Маршруты, не поставленные днём «сам», — с причиной (любой стиль). */
  selfSkipped: string[];
  /** Проверка безопасности мест не выполнилась хотя бы раз. */
  selfSafetyUnchecked: boolean;
  /**
   * Зоны, не вошедшие в план: связка «переезд + день там + возвращение» не
   * влезла в остаток дней. С числами, чтобы предупреждение было проверяемым.
   */
  skippedLegs: Array<{ zone: ZoneId; cost: ZoneLegCost; daysLeft: number; interests: string[] }>;
  /**
   * План кончился в чужой зоне, а дня на возвращение не нашлось. По
   * построению не должно случаться (день зарезервирован при входе) — поэтому
   * это самопроверка, а не штатный исход: молчание здесь и было дефектом.
   */
  returnLegMissing: ZoneId | null;
}

/** День отдыха по просьбе человека (не автоматический после тяжёлого дня). */
function requestedRestDay(day: number, zone: ZoneId): DayPlan {
  return {
    day, type: 'rest', zone,
    title: 'День отдыха',
    description: 'Вы просили день без активностей: выспаться, горячие источники, прогулка рядом с жильём.',
    activityType: 'hot_spring',
    priceFrom: 0, priceTo: 5000,
    coords: zone === 'avachinsky' ? PKC_COORDS : ZONE_COORDS[zone],
    defaultTransport: 'walking', allowedTransports: ['walking'],
    difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
  };
}

/** Метка на дне, который в стиле «С оператором» остался без тура. */
const NO_OPERATOR_TOUR_NOTE =
  'Тура оператора на этот день в ваши даты не нашли — поставили без тура. Уточните у оператора или спросите Кузьмича.';

async function generateDayPlans(
  profile: TripProfile,
  zones: ZoneRecommendation[],
  tripDays: number,
  cache: PlannerCache,
  /** Открытое каталогом на этот месяц; `null` — каталог спросить не вышло. */
  catalogueOpen: Set<string> | null,
): Promise<DayPlanResult> {
  const unchecked = new Set<string>();
  if (tripDays <= 0 || zones.length === 0) return { days: [], unchecked: [], spanUnknown: [], tooLong: [], overLimit: [], preferenceNotes: [], selfSkipped: [], selfSafetyUnchecked: false, skippedLegs: [], returnLegMissing: null };
  const youngest = youngestChild(profile);
  const month = getMonth(profile);

  const days: DayPlan[] = [];
  let dayNum = 1;

  // ── День прибытия — только у прилетающего (lib/planner/trip-origin) ──
  //
  // У жителя края дня прилёта нет вовсе: он не летит, не акклиматизируется и
  // не теряет на это день. До 27.09 этот день ставился безусловно, вместе с
  // описанием про перелёт 8-9 часов и разницу с Москвой.
  const origin = asTripOrigin(profile.tripOrigin);
  const framing = framingDays(origin);
  const arrivalDay = arrivalDayText(origin, profile.flightArrivalTime);
  if (arrivalDay) {
    days.push({
      day: dayNum++, type: 'arrival', zone: 'avachinsky',
      title: arrivalDay.title,
      description: arrivalDay.description,
      activityType: 'hot_spring', priceFrom: 0, priceTo: 3000,
      coords: PKC_COORDS, defaultTransport: 'walking',
      allowedTransports: ['walking'], difficulty: 'easy',
      childFriendly: true, minChildAge: 0, dayWarnings: [],
    });
  }

  if (dayNum > tripDays) return { days, unchecked: [...unchecked], spanUnknown: [], tooLong: [], overLimit: [], preferenceNotes: [], selfSkipped: [], selfSafetyUnchecked: false, skippedLegs: [], returnLegMissing: null };

  // ── Active days budget ──
  const departureDays = framing.departure;
  const activeBudget = framedActiveBudget(tripDays, origin);

  // ── Стиль поездки и дни отдыха (владелец 26.09, lib/planner/travel-style) ──
  //
  // `mixed` и отсутствие стиля — прежний движок без единого отличия: все
  // ветки ниже включаются только при `style !== 'mixed'` или `restPlan > 0`.
  const style: TravelStyle = profile.travelStyle ?? 'mixed';
  const restRequested = Math.max(0, Math.floor(profile.restDays ?? 0));
  const restPlan = fitRestDays(restRequested, activeBudget);
  /** Бюджет активных дней за вычетом отдыха по просьбе. */
  const activityBudget = activeBudget - restPlan;
  const restEvery = restSpacing(activityBudget, restPlan);
  let restLeft = restPlan;
  let activeSinceRest = 0;
  /** Активности, которые в стиле «Сам» не ставятся, — с причиной. */
  const selfBlockedActivities = new Map<string, string>();
  /** Маршруты и места, не поставленные самостоятельным днём, — с причиной. */
  const selfSkipped = new Set<string>();
  /** Проверка безопасности мест не выполнилась хотя бы раз. */
  let selfSafetyUnchecked = false;
  /** Туры, у которых в даты поездки нет свободных мест (стиль «С оператором»). */
  const noSlotTours = new Set<string>();
  /**
   * Зоны, не вошедшие в план: связка (переезд + день там + возвращение) не
   * влезла в остаток дней. Хранится ПРИЧИНА с числами — иначе интерес
   * человека исчезает из плана молча (§4.0, решение владельца 27.09).
   */
  const skippedLegs: Array<{ zone: ZoneId; cost: ZoneLegCost; daysLeft: number; interests: string[] }> = [];

  // Determine zone allocation
  const zoneBlocks: Array<{ zone: ZoneId; interests: string[]; activeDays: number }> = [];
  const totalScore = zones.reduce((s, z) => s + z.score, 0) || 1;

  for (const z of zones) {
    const zoneInterests = profile.interests.filter(i => {
      const c = ACTIVITY_CONSTRAINTS[i];
      return c?.bestZones.includes(z.zone) && inSeason(i, month, catalogueOpen);
    });
    if (zoneInterests.length === 0) continue;
    const rawDays = Math.max(1, Math.round((z.score / totalScore) * activityBudget));
    zoneBlocks.push({ zone: z.zone, interests: zoneInterests, activeDays: rawDays });
  }

  // Normalize to active budget
  let totalAllocated = zoneBlocks.reduce((s, b) => s + b.activeDays, 0);
  while (totalAllocated > activityBudget && zoneBlocks.length > 1) {
    const last = zoneBlocks[zoneBlocks.length - 1];
    if (last.activeDays > 1) { last.activeDays--; totalAllocated--; }
    else { zoneBlocks.pop(); totalAllocated--; }
  }
  while (totalAllocated < activityBudget && zoneBlocks[0]) {
    zoneBlocks[0].activeDays++;
    totalAllocated++;
  }

  // Need helicopter buffer day?
  const needsHeliBuffer = profile.interests.some(i => ACTIVITY_CONSTRAINTS[i]?.requiredTransport === 'helicopter');

  // Пары «зона + активность», для которых общий день уже выдан: повторять
  // его нельзя (см. ниже, в цикле дней).
  const genericDays = new Set<string>();

  /** Туры без заполненной длительности: поставлены одним днём, но это догадка. */
  const spanUnknown = new Set<string>();
  /** Туры длиннее, чем дней в зоне: не поставлены и не урезаны. */
  const tooLong = new Set<string>();
  /** Места сверх природоохранного лимита на даты поездки — не предложены. */
  const overLimit = new Set<string>();

  // Insert travel days between different zones
  let prevZone: ZoneId = 'avachinsky';

  for (let bi = 0; bi < zoneBlocks.length; bi++) {
    const block = zoneBlocks[bi];

    // «Сам»: активности, куда без гида нельзя по нашим же данным, из блока
    // убираются — с причиной, которую увидит человек. Блок, где не осталось
    // ничего, не собирается вовсе (и переезд в него не нужен).
    if (style === 'self') {
      const allowed = block.interests.filter((i) => {
        const reason = activitySelfBlocker(i);
        if (reason) selfBlockedActivities.set(i, reason);
        return !reason;
      });
      if (allowed.length === 0) continue;
      block.interests = allowed;
    }

    // ── Заход в чужую зону: решается СВЯЗКОЙ, а не одним днём (27.09) ──
    //
    // Раньше проверка «хватает ли дней» стояла ПОСЛЕ того, как день переезда
    // уже добавлен, и отката не было. Отсюда два невыполнимых плана, снятых с
    // живого движка: поездка 5-6 дней получала день переезда в зону, где нет
    // ни одного дня; поездка 7 дней уезжала в Западную зону и вылетала из
    // Петропавловска, не возвращаясь. Правило и причина отказа —
    // lib/planner/zone-leg.ts.
    if (block.zone !== prevZone) {
      const daysLeft = tripDays - departureDays - (dayNum - 1);
      const cost = zoneLegCost(prevZone, block.zone);
      if (!legFits(cost, daysLeft)) {
        // Зона не берётся ВОВСЕ — ни дня переезда, ни дня в ней. Молчать
        // нельзя: интерес человека иначе исчезает из плана без объяснения
        // (§4.0). Причину собираем и отдаём предупреждением ниже.
        skippedLegs.push({
          zone: block.zone,
          cost,
          daysLeft,
          interests: block.interests.slice(),
        });
        continue;
      }
      const edge = ZONE_GRAPH[prevZone]?.[block.zone];
      if (edge?.needsTravelDay) {
        const transportLabel = edge.transports.includes('jeep')
          ? `Переезд на внедорожнике (~${edge.travelHours ?? '?'}ч, ${edge.distanceKm} км)`
          : `Перелёт на вертолёте (${edge.distanceKm} км)`;
        days.push({
          day: dayNum++, type: 'travel', zone: prevZone,
          title: `Переезд: ${ZONE_NAMES[prevZone]} → ${ZONE_NAMES[block.zone]}`,
          description: transportLabel,
          activityType: 'travel', priceFrom: edge.costPerPerson[0], priceTo: edge.costPerPerson[1],
          coords: ZONE_COORDS[block.zone], defaultTransport: edge.transports[0],
          allowedTransports: edge.transports, difficulty: 'easy',
          childFriendly: true, minChildAge: 0, dayWarnings: [],
        });
      }
    }

    // Fetch real operator tours (sorted by rating) + DB routes as fallback
    const primaryInterest = block.interests[0];
    // «Сам» туров не берёт вовсе: ни одного дня с оператором.
    const toursOrNull = style === 'self'
      ? []
      : await fetchRealToursForZone(block.zone, primaryInterest, block.activeDays + 2, cache);
    let realTours = toursOrNull ?? [];

    // «С оператором»: тур без свободных мест на даты поездки не ставится —
    // честная занятость (lib/planner/data), а не витрина. Туры, где мест
    // хватает на всю группу, идут первыми.
    if (style === 'operator' && realTours.length > 0 && profile.arrivalDate && profile.departureDate) {
      const fits: RealTour[] = [];
      const tight: RealTour[] = [];
      for (const t of realTours) {
        // Занятость не прочиталась — «мест нет» было бы враньём: тур остаётся
        // в плане, но не впереди тех, где места проверены.
        const slots = await fetchAvailabilityForTour(t.tourId, profile.arrivalDate, profile.departureDate, cache)
          .catch(() => null);
        if (slots === null) { tight.push(t); continue; }
        if (slots.length === 0) { noSlotTours.add(t.title); continue; }
        (slots.some((sl) => sl.remaining >= groupSize(profile)) ? fits : tight).push(t);
      }
      realTours = [...fits, ...tight];
    }

    // Кандидатов в самостоятельный день берём с запасом: часть отсеет
    // проверка безопасности ниже.
    const routeSpare = 6;
    const routesOrNull = realTours.length >= block.activeDays
      ? []
      : await fetchRoutesForZone(block.zone, primaryInterest, block.activeDays - realTours.length + routeSpare);
    let dbRoutes = routesOrNull ?? [];

    // Самостоятельный день ставится только там, где наши данные это
    // позволяют (lib/planner/travel-style) — в любом стиле. До 26.09
    // «Вперемешку» (и план без выбора: Кузьмич, MCP) ставил днём «сам»
    // маршрут с обязательной регистрацией МЧС; решение владельца — та же
    // проверка, что у «Сам». Туры операторов она не трогает.
    if (dbRoutes.length > 0) {
      const activityReason = activitySelfBlocker(primaryInterest);
      const safety = activityReason ? new Map() : await fetchSelfSafety(dbRoutes.map((r) => r.id), cache);
      if (safety === null) selfSafetyUnchecked = true;
      dbRoutes = dbRoutes.filter((r) => {
        const reason = activityReason
          ?? (safety === null ? SELF_SAFETY_UNKNOWN : routeSelfBlocker(safety.get(r.id)));
        if (reason) selfSkipped.add(`${r.title} — ${reason}`);
        return !reason;
      });
    }

    // Распределение потока (владелец 25.09: «всех туристов нельзя в один
    // поток — 500 человек на одну локацию с природоохранными
    // ограничениями»). Окно — дни поездки в этой зоне. Без дат прилёта
    // загрузку не к чему привязать: порядок не трогается (lib/planner/flow-balance).
    const windowFrom = profile.arrivalDate ? dateOfTripDay(profile.arrivalDate, dayNum) : null;
    const windowTo = profile.arrivalDate ? dateOfTripDay(profile.arrivalDate, dayNum + block.activeDays - 1) : null;
    const group = groupSize(profile);
    let tourLoads: Map<string, PlaceLoad[]> | null = null;
    if (windowFrom && windowTo) {
      if (dbRoutes.length > 0) {
        const { ranked, blocked } = rankByLoad(dbRoutes, await fetchCandidateLoads(dbRoutes.map(r => r.id), windowFrom, windowTo), group);
        dbRoutes = ranked;
        for (const b of blocked) overLimit.add(`${b.candidate.title} — ${overLimitText(b.place)}`);
      }
      // Тур — продукт оператора и его слоты: из плана не убирается, но
      // упор места в лимит называется на самом дне.
      if (realTours.length > 0) tourLoads = await fetchTourLoads(realTours.map(t => t.tourId), windowFrom, windowTo);
    }

    // Отказ запроса запоминается ИМЕННО как отказ. День при этом собирается
    // как прежде — общий день по паре «зона + активность» не лжёт: активность
    // в сезоне и зона её держит. Лгало бы ОБЪЯСНЕНИЕ недобора: сказать «вне
    // сезона» там, где мы просто не смогли посмотреть каталог, — выдать
    // «не знаю» за знание (§4.0).
    if (toursOrNull === null || routesOrNull === null) {
      unchecked.add(`${ZONE_NAMES[block.zone]} / ${ACTIVITY_NAMES[primaryInterest] ?? primaryInterest}`);
    }

    // Сборка дней зоны.
    //
    // `d` — индекс МАТЕРИАЛА (какой по счёту тур или маршрут берём),
    // `used` — сколько дней поездки этим материалом уже занято. До 20.09 это
    // было одно число, и потому многодневный тур занимал ровно один день:
    // «Многодневный летний тур (5 дней)» за 140 000 ₽ стоял в плане как
    // однодневная активность. Главный продукт оператора план не мог
    // представить в принципе.
    let d = 0;
    let used = 0;
    // Сколько раз подряд итерация не дала дня. Полный оборот по интересам
    // без единого дня значит, что материала больше нет, — и цикл обязан
    // остановиться сам. С `for (...; d++)` от зацикливания спасал заголовок;
    // у `while` эту работу делает счётчик, иначе `continue` крутится вечно.
    let barren = 0;
    while (used < block.activeDays && dayNum <= tripDays - departureDays) {
      if (barren >= block.interests.length) break;

      const interestIdx = d % block.interests.length;
      const interest = block.interests[interestIdx];
      const c = ACTIVITY_CONSTRAINTS[interest];
      if (!c) { d++; barren++; continue; }

      // Reality layer: try real tour first, then DB route
      const realTour: RealTour | null = d < realTours.length ? realTours[d] : null;
      const route = !realTour && d - realTours.length >= 0 ? dbRoutes[d - realTours.length] : null;

      // Ни тура, ни маршрута — день собирается из одного сезонного окна, и
      // второй такой день был бы КОПИЕЙ первого. Замер с прода 19.09: десять
      // дней без интересов в октябре давали восемь одинаковых строк
      // «thermal — Авачинская зона — от 1 500 ₽». Восемь копий одного дня
      // выглядят планом, планом не являясь: место, где нельзя сказать «нечем
      // наполнить», заполнилось повтором (§4.0). Теперь общий день по паре
      // «зона + активность» выдаётся ОДИН раз, а недобор называется словами
      // в предупреждении.
      if (!realTour && !route) {
        const genericKey = `${block.zone}:${interest}`;
        if (genericDays.has(genericKey)) { d++; barren++; continue; }
        genericDays.add(genericKey);
      }

      // Сколько дней поездки занимает этот тур. `null` — длительность не
      // заполнена: ставим одним днём, как раньше, но запоминаем — под таким
      // полем может лежать пятидневка (§4.0).
      const declaredSpan = realTour ? tourDaySpan(realTour.durationHours) : 1;
      if (realTour && declaredSpan === null) {
        spanUnknown.add(realTour.title);
      }
      const span = declaredSpan ?? 1;

      // Тур длиннее, чем дней в этой зоне. НЕ режем: «три дня из
      // пятидневного тура» — не продукт, его нельзя купить. Пропускаем и
      // говорим об этом словами.
      if (span > block.activeDays) {
        if (realTour) tooLong.add(`${realTour.title} (${span} дн.)`);
        d++; barren++;
        continue;
      }

      barren = 0;

      const coords: [number, number] = realTour
        ? [realTour.lat, realTour.lng]
        : route ? [route.lat, route.lng] : ZONE_COORDS[block.zone];
      const title = realTour?.title ?? route?.title
        ?? `${ACTIVITY_NAMES[interest] ?? interest} — ${ZONE_NAMES[block.zone]}`;

      const childOk = youngest === null || youngest >= c.minChildAge;
      const dayWarnings: string[] = [];
      if (!childOk && c.childAlternative) {
        dayWarnings.push(`Детям < ${c.minChildAge}: ${c.childAlternative}`);
      }
      if (c.safetyNotes) dayWarnings.push(...c.safetyNotes);
      const tourOver = realTour && tourLoads ? firstOverLimit(tourLoads.get(realTour.tourId) ?? [], group) : null;
      if (tourOver) {
        dayWarnings.unshift(`Природоохранный лимит в ваши даты: ${overLimitText(tourOver)}. Уточните у оператора другую дату.`);
      }
      // «С оператором», а тура на день нет — говорим на самом дне, а не
      // подменяем молча самостоятельным выходом.
      if (style === 'operator' && !realTour) dayWarnings.unshift(NO_OPERATOR_TOUR_NOTE);
      // Общий день (ни тура, ни маршрута) по активности, куда без гида
      // нельзя, — не приглашение идти самому: говорим это на самом дне.
      if (style === 'mixed' && !realTour && !route) {
        const guideOnly = activitySelfBlocker(interest);
        if (guideOnly) dayWarnings.unshift(`Только с гидом: ${guideOnly}. Ищите тур оператора.`);
      }

      // Health compatibility check
      const healthCheck = assessHealthCompatibility(
        interest, profile.seasickness ?? false, profile.healthNotes, profile.mobilityLevel
      );
      dayWarnings.push(...healthCheck.warnings);

      // Allowed transports = intersection of zone + activity
      const zoneTransports = ZONE_ALLOWED_TRANSPORT[block.zone];
      let allowed = c.allowedTransports.filter(t => zoneTransports.includes(t));

      // Seasickness: replace boat with best non-boat alternative
      if (profile.seasickness && allowed.includes('boat')) {
        const noBoat = allowed.filter(t => t !== 'boat');
        if (c.requiredTransport === 'boat') {
          dayWarnings.unshift('Морская болезнь: этот выход на воду. Примите таблетки от укачивания заранее. Уточните у оператора береговую альтернативу.');
        } else {
          allowed = noBoat.length > 0 ? noBoat : allowed;
          dayWarnings.unshift('Маршрут скорректирован: береговой / джип-вариант вместо катера.');
        }
      }

      const transport = c.requiredTransport && !(profile.seasickness && c.requiredTransport === 'boat')
        ? c.requiredTransport
        : (allowed.includes(c.defaultTransport) ? c.defaultTransport : allowed[0] ?? 'walking');

      // Seasickness alternative for boat_required activities
      let dayTitle = title;
      if (profile.seasickness && c.requiredTransport === 'boat' && interest === 'boat_trip') {
        dayTitle = 'Прогулка вдоль Авачинской бухты (береговой маршрут)';
      }

      // Build reality-enriched DayPlan fields
      let realTourData: DayPlan['realTour'];
      let realPrice: number | undefined;
      let availableDate: string | undefined;
      let slotsRemaining: number | undefined;
      let availability: DayPlan['availability'];
      let capacityWarning: string | undefined;
      let alternatives: DayPlan['alternatives'];
      let qualityScore: number | undefined;

      if (realTour) {
        realTourData = {
          tourId: realTour.tourId,
          operatorName: realTour.operatorName,
          operatorSlug: realTour.operatorSlug,
          operatorRating: realTour.operatorRating,
          tourRating: realTour.tourRating,
          reviewCount: realTour.tourReviewCount,
          verified: realTour.operatorVerified,
          maxParticipants: realTour.maxParticipants,
          weatherDependent: realTour.weatherDependent,
          durationHours: realTour.durationHours,
          lodgingIncluded: lodgingIncluded(realTour.included),
        };
        realPrice = realTour.basePrice;

        // Check availability for this tour
        if (profile.arrivalDate && profile.departureDate) {
          // Отказ чтения — даты и остатка не называем вовсе (не «0 мест»).
          const slots = await fetchAvailabilityForTour(
            realTour.tourId, profile.arrivalDate, profile.departureDate, cache
          ).catch(availabilityUnread(realTour.tourId));
          availability = slots === null ? 'unread' : slots.length > 0 ? 'open' : 'none';
          if (slots && slots.length > 0) {
            availableDate = slots[0].date;
            slotsRemaining = slots[0].remaining;
            const gs = groupSize(profile);
            if (slots[0].remaining < gs) {
              capacityWarning = `Свободно ${slots[0].remaining} из ${realTour.maxParticipants} мест, вас ${gs}. Возможно, придётся выбрать другую дату.`;
            } else if (slots[0].remaining <= 3) {
              capacityWarning = `Осталось ${slots[0].remaining} мест — высокий спрос`;
            }
          }
        }

        // Contingency alternatives
        const alts = await fetchContingencyAlternatives(realTour.tourId, cache);
        if (alts.length > 0) {
          alternatives = alts.map(a => ({
            tourId: a.tourId,
            title: a.title,
            price: a.basePrice,
            discountPercent: a.discountPercent,
          }));
        }

        // Quality score
        const revSignals = await fetchReviewSignals(realTour.tourId, cache);
        qualityScore = computeQualityScore({
          tourRating: realTour.tourRating,
          tourReviewCount: realTour.tourReviewCount,
          operatorRating: realTour.operatorRating,
          operatorReviewCount: realTour.operatorReviewCount,
          operatorVerified: realTour.operatorVerified,
          recentPositivePercent: revSignals?.recentPositivePercent ?? 0,
          verifiedReviewCount: revSignals?.verifiedReviews ?? 0,
        });
      }

      days.push({
        day: dayNum++, type: 'activity', zone: block.zone,
        title: dayTitle,
        description: realTour?.shortDescription ?? c.seasonNote ?? '',
        activityType: interest,
        priceFrom: realPrice ?? c.pricePerPerson[0],
        priceTo: realPrice ? Math.round(realPrice * 1.3) : c.pricePerPerson[1],
        coords,
        defaultTransport: transport,
        allowedTransports: allowed.length > 0 ? allowed : [transport],
        difficulty: (realTour?.difficulty as DayPlan['difficulty']) ?? c.difficulty,
        childFriendly: childOk,
        minChildAge: c.minChildAge,
        dayWarnings,
        activityMode: activityMode({ realTour, route }),
        realTour: realTourData,
        realPrice,
        availableDate,
        slotsRemaining,
        availability,
        capacityWarning,
        alternatives,
        qualityScore,
      });

      // Продолжение многодневного тура: те же дни поездки, но БЕЗ повторной
      // цены и без второй карточки тура. Цена многодневного тура — за весь
      // тур, а не за сутки; посчитать её N раз значило бы умножить счёт.
      for (let extra = 1; extra < span && used + extra <= block.activeDays && dayNum <= tripDays - departureDays; extra++) {
        days.push({
          day: dayNum++, type: 'activity', zone: block.zone,
          title: `${dayTitle} — день ${extra + 1} из ${span}`,
          description: 'Продолжение многодневного тура. Цена учтена в первом дне.',
          activityType: interest,
          priceFrom: 0, priceTo: 0,
          coords, defaultTransport: transport,
          allowedTransports: allowed.length > 0 ? allowed : [transport],
          difficulty: (realTour?.difficulty as DayPlan['difficulty']) ?? c.difficulty,
          childFriendly: childOk, minChildAge: c.minChildAge, dayWarnings: [],
          activityMode: activityMode({ realTour, route }),
          // Тот же тур — значит и ночь его, и смета её не считает отдельно.
          realTour: realTourData,
        });
      }

      used += span;
      d++;
      activeSinceRest += span;

      // Insert rest day after hard activities (if budget allows)
      if (c.difficulty === 'hard' && used < block.activeDays && dayNum <= tripDays - departureDays - 1) {
        days.push({
          day: dayNum++, type: 'rest', zone: block.zone,
          title: 'День отдыха. Термальные источники',
          description: 'Восстановление после сложной активности. Горячие источники, прогулки.',
          activityType: 'hot_spring',
          priceFrom: 1500, priceTo: 5000,
          coords: block.zone === 'avachinsky' ? PKC_COORDS : ZONE_COORDS[block.zone],
          defaultTransport: 'walking', allowedTransports: ['walking'],
          difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
        });
        // Отдых после тяжёлого дня засчитывается в просьбу человека: он
        // просил дни отдыха, а не отдых сверх необходимого восстановления.
        if (restLeft > 0) { restLeft--; activeSinceRest = 0; }
        else used += 1;
      }

      // Отдых по просьбе — ровно между активными днями, а не хвостом.
      if (restLeft > 0 && activeSinceRest >= restEvery && dayNum <= tripDays - departureDays) {
        days.push(requestedRestDay(dayNum++, block.zone));
        restLeft--;
        activeSinceRest = 0;
      }
    }

    prevZone = block.zone;
  }

  // ── Helicopter buffer day (before departure) ──
  if (needsHeliBuffer && dayNum <= tripDays - departureDays) {
    days.push({
      day: dayNum++, type: 'buffer', zone: 'avachinsky',
      title: 'Резервный день (нелётная погода)',
      description: 'Если все вертолётные экскурсии состоялись — свободный день: термальные источники, город, сувениры.',
      activityType: 'hot_spring',
      priceFrom: 0, priceTo: 5000,
      coords: PKC_COORDS, defaultTransport: 'walking',
      allowedTransports: ['walking', 'jeep'], difficulty: 'easy',
      childFriendly: true, minChildAge: 0,
      dayWarnings: ['Резерв на случай отмены вертолётных рейсов из-за погоды'],
    });
  }

  // ── Возвращение в Авачинскую зону, если последняя зона не она ──
  //
  // День возвращения зарезервирован ещё при входе в зону (zone-leg.ts), так что
  // место под него есть по построению. Самопроверка ниже всё равно стоит: если
  // резерв когда-нибудь разойдётся с раскладкой, план не должен УМОЛЧАТЬ об
  // этом — до 27.09 он именно умалчивал, и человек улетал из Петропавловска,
  // ночуя в Западной зоне.
  let returnLegMissing: ZoneId | null = null;
  if (prevZone !== 'avachinsky' && dayNum <= tripDays - departureDays) {
    const backEdge = ZONE_GRAPH[prevZone]?.['avachinsky'];
    if (backEdge) {
      days.push({
        day: dayNum++, type: 'travel', zone: 'avachinsky',
        title: `Возвращение: ${ZONE_NAMES[prevZone]} → Петропавловск`,
        description: backEdge.transports.includes('jeep')
          ? `Переезд ~${backEdge.travelHours ?? '?'}ч`
          : 'Перелёт на вертолёте',
        activityType: 'travel', priceFrom: backEdge.costPerPerson[0], priceTo: backEdge.costPerPerson[1],
        coords: PKC_COORDS, defaultTransport: backEdge.transports[0],
        allowedTransports: backEdge.transports, difficulty: 'easy',
        childFriendly: true, minChildAge: 0, dayWarnings: [],
      });
      prevZone = 'avachinsky';
    } else {
      returnLegMissing = prevZone;
    }
  } else if (prevZone !== 'avachinsky') {
    returnLegMissing = prevZone;
  }

  // ── Отдых по просьбе, не вставший между активными днями ──
  // (блоки кончились раньше, чем подошла его очередь). Сверх срока — нет.
  while (restLeft > 0 && dayNum <= tripDays - departureDays) {
    days.push(requestedRestDay(dayNum++, 'avachinsky'));
    restLeft--;
  }

  // ── Один свободный день, если бюджет остался ──
  //
  // Раньше здесь стоял `while`, добивавший остаток поездки копиями одной и
  // той же строки про рыбный рынок. Свободный день в поездке — норма, восемь
  // одинаковых свободных дней — не план, а заполненная пустота. Один день
  // выдаётся, остаток честно остаётся незаполненным: о нём говорит
  // предупреждение в `recommendTrip`.
  if (dayNum <= tripDays - departureDays) {
    days.push({
      day: dayNum++, type: 'activity', zone: 'avachinsky',
      title: 'Свободный день. Город, сувениры, рыбный рынок',
      description: 'Прогулка по Петропавловску, смотровые площадки, кафе.',
      activityType: 'hot_spring', priceFrom: 0, priceTo: 5000,
      coords: PKC_COORDS, defaultTransport: 'walking',
      allowedTransports: ['walking', 'jeep'], difficulty: 'easy',
      childFriendly: true, minChildAge: 0,
      dayWarnings: style === 'operator' ? ['Свободный день: тур оператора на него не ставили.'] : [],
      // Город пешком — самостоятельный день, тура за ним нет.
      activityMode: 'self',
    });
  }

  // ── Последний день: вылет ──
  //
  // Номер дня вылета — ДАТА ОТЪЕЗДА, а не счётчик заполненных дней (правка
  // 27.09). Раньше день вылета получал `dayNum`, то есть съезжал вперёд ровно
  // на столько, сколько дней движок не смог наполнить: поездка 10.07-17.07
  // показывала «Сборы утром. Трансфер в аэропорт» шестым днём из семи. Человек
  // читает последнюю строку плана как день своего рейса — и получал не ту дату.
  // Про сам недобор говорит отдельное предупреждение «наполнили N из M», и
  // разрыв в нумерации теперь ему соответствует.
  //
  // У жителя края этого дня нет: `departureDayText` возвращает `null`, и
  // последний день поездки остаётся рабочим. Раньше он получал «Сборы утром.
  // Трансфер в аэропорт» — строку про рейс, которого нет.
  const departureDay = departureDayText(origin, profile.flightDepartureTime);
  if (departureDay && dayNum <= tripDays) {
    days.push({
      day: tripDays, type: 'departure', zone: 'avachinsky',
      title: departureDay.title,
      description: departureDay.description,
      activityType: 'departure', priceFrom: 0, priceTo: 2500,
      coords: PKC_COORDS, defaultTransport: 'walking',
      allowedTransports: ['walking'], difficulty: 'easy',
      childFriendly: true, minChildAge: 0, dayWarnings: [],
    });
  }

  const preferenceNotes = describePreferences({
    style, restRequested, days, tripDays, origin,
    selfBlockedActivities, selfSkipped, selfSafetyUnchecked, noSlotTours,
  });

  return {
    days, unchecked: [...unchecked], spanUnknown: [...spanUnknown], tooLong: [...tooLong], overLimit: [...overLimit], preferenceNotes,
    selfSkipped: [...selfSkipped], selfSafetyUnchecked, skippedLegs, returnLegMissing,
  };
}

/** Короткий список: до трёх пунктов и «ещё N». */
function listShort(items: string[]): string {
  return items.slice(0, 3).join('; ') + (items.length > 3 ? ` и ещё ${items.length - 3}` : '');
}

/**
 * Заметки «что попросили — что вышло». Просьба не выполнена — говорится
 * словами и с причиной; молча выполненная наполовину просьба читалась бы как
 * выполненная целиком (§4.0).
 */
function describePreferences(input: {
  style: TravelStyle;
  restRequested: number;
  days: DayPlan[];
  tripDays: number;
  selfBlockedActivities: Map<string, string>;
  selfSkipped: Set<string>;
  selfSafetyUnchecked: boolean;
  noSlotTours: Set<string>;
  /** Прилетает или живёт в крае: у местного служебных дней нет. */
  origin: TripOrigin;
}): PreferenceNote[] {
  const notes: PreferenceNote[] = [];
  const { style, days } = input;
  const active = days.filter((d) => d.type === 'activity');

  if (style === 'self') {
    const blocked = [...input.selfBlockedActivities.values()];
    const skipped = [...input.selfSkipped];
    if (blocked.length > 0) {
      notes.push({
        topic: 'travel_style', status: 'partial',
        message: `Самостоятельно не ставим: ${listShort(blocked)}. Эти дни — только с гидом: выберите «С оператором» или «Вперемешку».`,
      });
    }
    if (input.selfSafetyUnchecked) {
      notes.push({
        topic: 'travel_style', status: 'partial',
        message: 'Не удалось проверить безопасность мест — самостоятельные выходы по ним не ставили. Попробуйте собрать маршрут ещё раз.',
      });
    } else if (skipped.length > 0) {
      notes.push({
        topic: 'travel_style', status: 'partial',
        message: `Не ставим без гида: ${listShort(skipped)}.`,
      });
    }
    if (notes.length === 0 && active.length === 0) {
      // Пустой план — не «исполнено»: исполнять было нечем.
      notes.push({
        topic: 'travel_style', status: 'not_honoured',
        message: 'Самостоятельных дней под ваши интересы и даты не нашлось.',
      });
    } else if (notes.length === 0) {
      notes.push({
        topic: 'travel_style', status: 'honoured',
        message: 'Все активные дни — самостоятельные: туры операторов не ставили.',
      });
    }
  }

  if (style === 'operator') {
    const withTour = active.filter((d) => d.activityMode === 'operator').length;
    const without = active.length - withTour;
    if (input.noSlotTours.size > 0) {
      notes.push({
        topic: 'travel_style', status: 'partial',
        message: `В ваши даты нет свободных мест: ${listShort([...input.noSlotTours])} — эти туры не ставили.`,
      });
    }
    if (withTour === 0) {
      notes.push({
        topic: 'travel_style', status: 'not_honoured',
        message: 'Туров операторов под ваши даты и интересы не нашли. Дни плана — без тура; сдвиньте даты или добавьте интересы.',
      });
    } else if (without > 0) {
      notes.push({
        topic: 'travel_style', status: 'partial',
        message: `С оператором — ${withTour} ${pluralDays(withTour)} из ${active.length}. На остальные тура в ваши даты нет — это отмечено на самих днях.`,
      });
    } else {
      notes.push({
        topic: 'travel_style', status: 'honoured',
        message: `Все активные дни — туры операторов со свободными местами на ваши даты.`,
      });
    }
  }

  if (input.restRequested > 0) {
    const planned = days.filter((d) => d.type === 'rest').length;
    if (planned >= input.restRequested) {
      notes.push({
        topic: 'rest_days', status: 'honoured',
        message: `Дней отдыха в плане: ${planned}.`,
      });
    } else {
      notes.push({
        topic: 'rest_days', status: planned > 0 ? 'partial' : 'not_honoured',
        message: `Отдыха поместилось ${planned} ${pluralDays(planned)} из ${input.restRequested}: в поездке ${input.tripDays} ${pluralDays(input.tripDays)}, `
          + (input.origin === 'local'
            ? 'и место нужно хотя бы одному активному дню. Добавьте дней, и отдыха станет больше.'
            : 'и место нужно прилёту, вылету и хотя бы одному активному дню. Добавьте дней, и отдыха станет больше.'),
      });
    }
  }

  return notes;
}

// ── Price breakdown ─────────────────────────────────────────────────────────

function calculatePriceBreakdown(days: DayPlan[], profile: TripProfile): PriceBreakdown {
  const bi = budgetIndex(profile.budgetTier);
  const nightCount = Math.max(0, days.length - 1);

  // Activities total
  const actFrom = days.filter(d => d.type === 'activity' || d.type === 'buffer').reduce((s, d) => s + (d.realPrice ?? d.priceFrom), 0);
  const actTo   = days.filter(d => d.type === 'activity' || d.type === 'buffer').reduce((s, d) => s + (d.realPrice ? Math.round(d.realPrice * 1.2) : d.priceTo), 0);

  // Ночёвки. Оценка по зоне — только за те ночи, которые турист ДЕЙСТВИТЕЛЬНО
  // оплачивает отдельно.
  //
  // Замер 20.09: у тура ID9 «Камчатской рыбалки» в составе прямым текстом
  // «Проживание на базе 5 ночей» при цене 140 000 ₽, а этот цикл прибавлял
  // ночь за каждый не-отъездный день безусловно. Западная зона при comfort —
  // 20 000 ₽/ночь: семидневный план показывал ещё 96 000–160 000 ₽
  // «проживания», которого турист не платит.
  //
  // `null` (не разобрали состав) считается как «платит»: занижать счёт на
  // догадке хуже, чем завысить и сказать об этом вслух — предупреждение
  // ставит `recommendTrip`.
  //
  // У местного ночь в своей зоне не считается вовсе (lib/planner/trip-origin):
  // он ночует у себя. Допущение о доме названо словами в предупреждениях —
  // молча занижать счёт на догадке об адресе нельзя.
  const origin = asTripOrigin(profile.tripOrigin);
  let accFrom = 0;
  let accTo = 0;
  /**
   * У ПОСЛЕДНЕГО дня поездки ночи нет — человек либо улетает, либо едет
   * домой. Правило одно на оба случая: раньше пропускался только день с
   * типом `departure`, и у местного (у которого такого дня нет вовсе) ночей
   * выходило на одну больше, чем он проводит вне дома.
   */
  const lastDayNum = days.length > 0 ? days[days.length - 1]!.day : 0;
  for (const day of days) {
    if (day.type === 'departure' || day.day === lastDayNum) continue;
    if (day.realTour?.lodgingIncluded === true) continue;
    // В зоне не ночуют — ночь считается там, где ночуют на самом деле.
    const sleepZone = sleepZoneOf(day.zone);
    if (nightIsAtHome(origin, sleepZone)) continue;
    const acc = ZONE_ACCOMMODATION[sleepZone];
    const nightPrice = acc.pricePerNight[bi] || acc.pricePerNight[0];
    accFrom += Math.round(nightPrice * 0.8);
    accTo   += Math.round(nightPrice * 1.2);
  }
  if (nightCount === 0) { accFrom = 0; accTo = 0; }

  // Transport — travel days + transfers
  // Трансферы аэропорта — только у прилетающего: местный туда не едет.
  const travelDays = days.filter(d => d.type === 'travel');
  const transferFrom = paysAirportTransfers(origin) ? 2500 : 0;
  const transferTo = paysAirportTransfers(origin) ? 5000 : 0;
  const transFrom = travelDays.reduce((s, d) => s + d.priceFrom, 0) + transferFrom;
  const transTo   = travelDays.reduce((s, d) => s + d.priceTo, 0) + transferTo;

  return {
    activities: [actFrom, actTo],
    accommodation: [accFrom, accTo],
    transport: [transFrom, transTo],
    perPersonTotal: [actFrom + accFrom + transFrom, actTo + accTo + transTo],
  };
}

// ── AI itinerary ────────────────────────────────────────────────────────────

function buildAIPrompt(profile: TripProfile, zones: ZoneRecommendation[], days: DayPlan[], warnings: TripWarning[]): string {
  const groupDesc = [`${profile.adults} взрослых`];
  if (profile.children.length > 0) {
    groupDesc.push(`дети: ${profile.children.map(a => `${a} лет`).join(', ')}`);
  }

  const daysSummary = days.map(d => {
    let line = `День ${d.day} (${d.type}): ${d.title} [${d.zone}]`;
    if (d.realTour) {
      line += ` — оператор: ${d.realTour.operatorName} (${d.realTour.operatorRating.toFixed(1)})`;
    }
    if (d.realPrice) {
      line += ` — ${d.realPrice} ₽`;
    }
    if (d.weatherForecast) {
      line += ` | ${d.weatherForecast.description}, ${d.weatherForecast.tempMin}..${d.weatherForecast.tempMax} C`;
    }
    return line;
  }).join('\n');

  const warningsSummary = warnings
    .filter(w => !HEALTH_DERIVED.has(w))
    .filter(w => w.severity === 'critical' || w.severity === 'important')
    .map(w => `- ${w.message}`)
    .join('\n');

  return `Ты помощник туристического планирования на Камчатке. Создай вдохновляющее описание маршрута (5-8 предложений).

Группа: ${groupDesc.join(', ')}
Уровень: ${profile.fitnessLevel}
Бюджет: ${profile.budgetTier}
Даты: ${profile.arrivalDate ?? 'не указаны'} — ${profile.departureDate ?? 'не указаны'}

Зоны: ${zones.map(z => `${ZONE_NAMES[z.zone]} (${z.score}%)`).join(', ')}

План по дням:
${daysSummary}

${warningsSummary ? `Предупреждения:\n${warningsSummary}` : ''}

Опиши маршрут на русском, учитывая:
- Дни переезда и отдыха — это норма, не извиняйся за них
- Если есть дети — упомяни что программа адаптирована
- Упомяни ключевые впечатления: что увидят, что почувствуют
- Если есть реальные операторы — упомяни их и рейтинг
- Если есть прогноз погоды — кратко упомяни что ожидать
- Не нумеруй дни, пиши связным текстом`;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * `itinerary: 'plain'` — без AI-пересказа маршрута. Его зовёт make_trip_plan
 * Кузьмича и публичного MCP, который поле itinerary не читает вовсе: каждый
 * анонимный вызов платил флагманскую модель и ждал до 15 с ради строки,
 * выброшенной следом (проверка MCP 29.09). Веб-планер и агентство — как были.
 */
export interface RecommendTripOptions {
  itinerary?: 'ai' | 'plain';
}

export async function recommendTrip(profile: TripProfile, opts: RecommendTripOptions = {}): Promise<TripRecommendation> {
  if (!profile.interests || profile.interests.length === 0) {
    return {
      zones: [], days: [], warnings: [],
      priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] },
      itinerary: 'Выберите интересы для рекомендации.',
      // Каталог не спрашивали вовсе — это «не знаем», а не «пусто».
      catalogueOpen: null,
    };
  }

  const tripDays = getTripDays(profile);
  const cache = createPlannerCache();

  // Fetch context data in parallel
  const [alerts] = await Promise.all([
    fetchSafetyAlerts(profile.arrivalDate, profile.departureDate),
  ]);

  // Каталог спрашивается ОДИН раз и кормит все три места, где решает
  // сезон: иначе они разошлись бы между собой (§10.09).
  const catalogueOpen = await fetchActivitiesBookableInMonth(getMonth(profile), cache);

  const zones = await scoreZones(profile, cache, catalogueOpen);
  // Дни собираются ДО предупреждений (27.09): предупреждения о разрешениях и
  // удалённых зонах должны считаться по зонам ГОТОВОГО плана, а не по
  // зонам-кандидатам. До этой правки человек с планом по Авачинской и
  // Западной читал два КРИТИЧЕСКИХ требования про Восточную зону (заказник
  // за 14 дней, погранзона ФСБ за 30) — про поездку, которой нет. Шум в
  // предупреждениях учит не читать предупреждения (тот же урок 15.09 про
  // «Раздолье»).
  const { days, unchecked, spanUnknown, tooLong, overLimit, preferenceNotes, selfSkipped, selfSafetyUnchecked, skippedLegs, returnLegMissing } = await generateDayPlans(profile, zones, tripDays, cache, catalogueOpen);
  const plannedZones = new Set<ZoneId>(days.map((d) => d.zone));
  const warnings = collectWarnings(profile, zones, tripDays, 0, alerts, catalogueOpen, plannedZones);

  // Каталог открыл то, что зашитая таблица считает закрытым. Промолчать
  // нельзя ни в одну сторону: отказать — значит не продать то, что оператор
  // продаёт (замер 20.09: семь туров из восьми рыболовные, и один из них
  // «Осенняя рыбалка (октябрь-ноябрь)» при `fishing.months` = [6,7,8,9]);
  // согласиться молча — скрыть, что наш сезонный ориентир говорит другое, а
  // он несёт и безопасность, не только коммерцию.
  const catalogueOnly = openedByCatalogueOnly(profile.interests, getMonth(profile), catalogueOpen);
  if (catalogueOnly.length > 0) {
    const names = catalogueOnly.map(i => ACTIVITY_NAMES[i] ?? i).join(', ');
    warnings.push({
      type: 'season',
      severity: 'important',
      message: `${names}: по нашему сезонному ориентиру это уже не сезон, но оператор открыл запись на этот месяц. `
        + 'Взяли по записи оператора — он отвечает за выход; погоду и снаряжение уточните у него отдельно.',
    });
  }

  // Каталог не прочитался — сезон судит один зашитый список, и это надо
  // сказать: «не знаем» не равно «в каталоге ничего нет».
  if (catalogueOpen === null) {
    warnings.push({
      type: 'season',
      severity: 'important',
      message: 'Не удалось свериться с записью операторов на этот месяц — сезон определён по нашему ориентиру. '
        + 'Что-то из закрытого им могло быть в продаже; уточните у оператора.',
    });
  }

  // Adventure mode warning
  if (profile.riskMode === 'adventure') {
    warnings.unshift({
      type: 'safety',
      severity: 'important',
      message: 'Вы выбрали режим Приключение. Маршруты могут содержать активные предупреждения МЧС, лавинную или вулканическую опасность. Убедитесь в наличии правильного снаряжения и гидa.',
    });
  }

  // ── Зона, на которую не хватило дней, называется словами (27.09) ──
  //
  // Решение владельца: не ездить и сказать. Молчание читалось бы как «этого
  // интереса у нас нет», хотя причина — арифметика календаря (§4.0).
  for (const leg of skippedLegs) {
    warnings.push({
      type: 'zone_days',
      severity: 'info',
      message: legShortfallMessage(
        leg.zone,
        leg.cost,
        leg.daysLeft,
        leg.interests.map((i) => ACTIVITY_NAMES[i] ?? i),
      ),
    });
  }

  // Допущение о доме местного — словами рядом со счётом, а не молча в цифре.
  // Условие узкое намеренно: если план вообще не ночует в Авачинской зоне,
  // допущение ни на что не повлияло, и говорить о нём нечего.
  if (asTripOrigin(profile.tripOrigin) === 'local' && plannedZones.has(LOCAL_HOME_ZONE)) {
    warnings.push({ type: 'home_nights', severity: 'info', message: HOME_NIGHTS_ASSUMPTION });
  }

  // Самопроверка: план кончился в чужой зоне без дня на возвращение. По
  // построению невозможно — поэтому если это случилось, говорим громко, а не
  // отдаём человеку невыполнимый план, как было до 27.09.
  if (returnLegMissing) {
    warnings.push({
      type: 'zone_days',
      severity: 'critical',
      message: `План кончается в ${ZONE_NAMES[returnLegMissing] ?? returnLegMissing}, а дня на возвращение в Петропавловск в нём нет — `
        + (asTripOrigin(profile.tripOrigin) === 'local'
          ? 'вернуться в город в тот же день не выйдет. Добавьте день к поездке или уберите дальнюю зону; мы это учтём при следующей сборке.'
          : 'вылет из города в тот же день невозможен. Добавьте день к поездке или уберите дальнюю зону; мы это учтём при следующей сборке.'),
    });
  }

  // «Вперемешку» и план без выбора стиля (Кузьмич, MCP): что не поставлено
  // самостоятельным днём и почему — предупреждением, которое доходит до
  // всех поверхностей. У «Сам» и «С оператором» это говорят заметки
  // пожеланий, второй раз не повторяем.
  if ((profile.travelStyle ?? 'mixed') === 'mixed') {
    if (selfSafetyUnchecked) {
      warnings.push({
        type: 'safety', severity: 'important',
        message: 'Не удалось проверить безопасность мест — самостоятельные выходы по ним в план не ставили. Попробуйте собрать маршрут ещё раз.',
      });
    } else if (selfSkipped.length > 0) {
      warnings.push({
        type: 'safety', severity: 'important',
        message: `Без гида не ставим: ${selfSkipped.slice(0, 3).join('; ')}`
          + (selfSkipped.length > 3 ? ` и ещё ${selfSkipped.length - 3}` : '')
          + '. Туда — только с оператором.',
      });
    }
  }

  // Место не предложено из-за природоохранного лимита — говорим, какое и
  // чья норма. Молча подменить место другим значило бы спрятать причину.
  if (overLimit.length > 0) {
    warnings.push({
      type: 'crowd',
      severity: 'important',
      message: `В ваши даты заполнено по норме и потому не предложено: ${overLimit.slice(0, 3).join('; ')}`
        + (overLimit.length > 3 ? ` и ещё ${overLimit.length - 3}` : '')
        + '. Поток распределяется, чтобы не превышать ограничения мест.',
    });
  }

  // «Не смогли посмотреть каталог» — отдельное предупреждение и отдельными
  // словами. Раньше отказ запроса возвращался пустым списком и был
  // неотличим от «туров нет»: план собирался из общих дней, а недобор
  // объяснялся сезоном — то есть причина НАЗЫВАЛАСЬ там, где её не знали.
  if (unchecked.length > 0) {
    warnings.push({
      type: 'duration',
      severity: 'important',
      message: `Не удалось проверить наличие туров: ${unchecked.slice(0, 3).join('; ')}`
        + (unchecked.length > 3 ? ` и ещё ${unchecked.length - 3}` : '')
        + '. Это «не знаем», а не «туров нет» — план по этим дням может быть беднее реального.',
    });
  }

  // Тур не поместился в срок — и НЕ урезан. «Три дня из пятидневного тура»
  // не продукт, его нельзя купить; поставить его усечённым значило бы
  // показать расписание, которое не состоится.
  if (tooLong.length > 0) {
    warnings.push({
      type: 'duration',
      severity: 'important',
      message: `Не поместились в срок поездки и потому не вошли в план: ${tooLong.slice(0, 3).join('; ')}`
        + (tooLong.length > 3 ? ` и ещё ${tooLong.length - 3}` : '')
        + '. Резать тур по границе поездки нельзя — его продают целиком. Добавьте дней, и они войдут.',
    });
  }

  // Длительность не заполнена — тур поставлен одним днём, и это догадка.
  //
  // Молчать нельзя: под незаполненным полем может лежать пятидневка, и
  // тогда неверен весь порядок дней, а не одна строка. Именно так
  // «Многодневный летний тур (5 дней)» и стоял в плане однодневным.
  if (spanUnknown.length > 0) {
    warnings.push({
      type: 'duration',
      severity: 'important',
      message: `Длительность не указана у ${spanUnknown.slice(0, 3).join('; ')}`
        + (spanUnknown.length > 3 ? ` и ещё ${spanUnknown.length - 3}` : '')
        + ' — поставили одним днём. Если тур многодневный, порядок дней в плане сдвинется; уточните у оператора.',
    });
  }

  // Состав тура не разобрался — ночь посчитана, и об этом говорится.
  //
  // Молчать нельзя именно потому, что ошибка идёт В СТОРОНУ ЗАВЫШЕНИЯ: смета
  // выглядит точной, а турист платит меньше. «Дороже, чем на самом деле» —
  // не безобидная осторожность, по такой смете отказываются от поездки.
  const unknownLodging = days.filter(d => d.realTour && d.realTour.lodgingIncluded === null);
  if (unknownLodging.length > 0) {
    warnings.push({
      type: 'duration',
      severity: 'important',
      message: `Состав ${unknownLodging.length === 1 ? 'одного тура' : `${unknownLodging.length} туров`} в плане не заполнен, `
        + 'поэтому ночёвку по ним посчитали отдельно. Если проживание уже входит в тур, '
        + 'итог в смете завышен — уточните у оператора.',
    });
  }

  // ── План короче запрошенного — это факт, и он говорится словами ──────────
  //
  // Добивать остаток копиями движок больше не умеет (19.09), значит разница
  // между «просили 10 дней» и «наполнили 4» стала видимой. Видимой она и
  // должна быть: молчание здесь читается как «вот ваши четыре дня», то есть
  // как обещание, что больше на Камчатке в этот месяц делать нечего.
  if (days.length > 0 && days.length < tripDays) {
    const month = getMonth(profile);
    const offSeason = profile.interests
      .filter(i => ACTIVITY_CONSTRAINTS[i] && !ACTIVITY_CONSTRAINTS[i].months.includes(month))
      .map(i => ACTIVITY_NAMES[i] ?? i);
    // Причина называется ТОЛЬКО когда она известна. Если хоть одна проверка
    // каталога не выполнилась, «вне сезона» — уже не факт, а догадка: там
    // могли быть туры, которых мы не увидели.
    const reason = unchecked.length > 0
      ? ': часть проверок наличия туров не выполнилась, поэтому причину недобора назвать не берёмся'
      : offSeason.length > 0
        ? `: в этом месяце вне сезона ${offSeason.join(', ')}`
        : ': подтверждённых выходов на остальные дни у нас нет';

    warnings.push({
      type: 'duration',
      severity: 'important',
      message: `Наполнили ${days.length} ${pluralDays(days.length)} из ${tripDays}${reason}`
        + '. Остальные дни не придумываем — сдвиньте даты или добавьте интересы, и план соберётся полнее.',
    });
  }

  // Прогноз к дням плана — по ДАТЕ дня, от даты приезда. До 25.09 прогноз
  // брался от сегодня и раскладывался по номеру дня: при приезде через неделю
  // первый день плана получал сегодняшнюю погоду, и она же уходила в промпт.
  // Поездка за горизонтом прогноза или неполный день — погоды у дня нет.
  if (profile.arrivalDate && days.length > 0) {
    const primaryZone = zones[0]?.zone ?? 'avachinsky';
    const window = tripForecastWindow(profile.arrivalDate, Math.max(...days.map((d) => d.day)));
    if (window) {
      const forecast = await fetchForecastDays(
        ZONE_COORDS[primaryZone][0],
        ZONE_COORDS[primaryZone][1],
        window.horizon,
      );
      if (forecast.ok) {
        for (const day of days) {
          const date = window.dates[day.day - 1];
          const fc = date ? forecast.days.find((f) => f.date === date) : undefined;
          if (!fc || fc.tempMax === null || fc.tempMin === null || fc.precipMm === null
            || fc.windKmh === null || fc.weatherCode === null || fc.description === null) continue;
          day.weatherForecast = {
            tempMax: fc.tempMax,
            tempMin: fc.tempMin,
            precipMm: fc.precipMm,
            windKmh: fc.windKmh,
            code: fc.weatherCode,
            description: fc.description,
          };
        }
      }
    }
  }

  const priceBreakdown = calculatePriceBreakdown(days, profile);

  // AI itinerary — include seasickness context
  let itinerary = `Маршрут на ${tripDays} дней по Камчатке: ${zones.map(z => ZONE_NAMES[z.zone]).join(', ')}.`;

  if (opts.itinerary !== 'plain') {
    try {
      const aiPrompt = buildAIPrompt(profile, zones, days, warnings);
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Ты ассистент по туристическому планированию Камчатки.' },
        { role: 'user', content: aiPrompt },
      ];
      const aiResponse = await callAIWithModelDirect(messages, getModelForAgent('planner'));
      if (aiResponse?.trim()) itinerary = aiResponse;
    } catch (err) {
      // Запасной текст уже стоит; отказ модели называется в логе (§4.0).
      console.error('[planner] AI-маршрут не получен:', err instanceof Error ? err.message : String(err));
    }
  }

  // Просьба была — ответ о ней обязателен, даже если заметок нет. Просьбы
  // не было — ответ движка прежний, без нового поля.
  const preferences: TripPreferences | undefined =
    profile.travelStyle !== undefined || profile.restDays !== undefined
      ? {
        travelStyle: profile.travelStyle ?? 'mixed',
        restDaysRequested: Math.max(0, Math.floor(profile.restDays ?? 0)),
        restDaysPlanned: days.filter((d) => d.type === 'rest').length,
        notes: preferenceNotes,
      }
      : undefined;

  return {
    zones, days, warnings, priceBreakdown, itinerary,
    catalogueOpen: catalogueOpen ? [...catalogueOpen] : null,
    ...(preferences ? { preferences } : {}),
  };
}


/**
 * Fire-and-forget AI reasoning для каждого дня маршрута.
 * Объясняет туристу почему именно эта активность рекомендуется.
 */
async function generateDayReasoning(days: DayPlan[], profile: TripProfile): Promise<void> {
  if (days.length === 0) return;

  const interestStr = profile.interests.join(', ') || 'разнообразный отдых';
  const childAges = profile.children.length > 0 ? `дети: ${profile.children.join(', ')} лет` : 'без детей';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты эксперт по туризму на Камчатке. Для каждого дня маршрута напиши 1 короткое предложение (макс 15 слов) на русском: ПОЧЕМУ именно эта активность подходит данному туристу. Учитывай интересы, уровень физической подготовки, детей, бюджет. Будь конкретным. Без emoji, без markdown.`,
    },
    {
      role: 'user',
      content: `Турист: интересы — ${interestStr}, уровень — ${profile.fitnessLevel}, бюджет — ${profile.budgetTier}, ${childAges}.\n\nМаршрут:\n${days.map((d, i) => `${i + 1}. День ${d.day}: ${d.title} (${d.type}, ${d.difficulty}, ${d.priceFrom}-${d.priceTo} руб)`).join('\n')}\n\nФормат: 1: <объяснение>\n2: <объяснение>...`,
    },
  ];

  try {
    const result = await callAIWithModelDirect(messages, getModelForAgent('planner'));
    if (!result) return;

    const lines = result.split('\n').filter(l => l.trim());
    for (const line of lines) {
      const match = line.match(/^(\d+)\s*[:.)]\s*(.+)$/);
      if (match) {
        const idx = parseInt(match[1]) - 1;
        const reasoning = match[2].trim();
        if (idx >= 0 && idx < days.length && reasoning.length > 5) {
          days[idx].reasoning = reasoning;
        }
      }
    }
  } catch {
    // AI недоступен — не критично
  }
}
