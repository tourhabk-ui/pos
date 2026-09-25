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
  ZONE_NAMES, ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES,
} from '@/lib/planner/constants';

export {
  type ZoneId, type TransportType, type FitnessLevel, type ActivityConstraints,
  ZONE_NAMES, ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES,
};
import {
  createPlannerCache, fetchRealToursForZone, fetchAvailabilityForTour,
  fetchZoneCapacity, fetchContingencyAlternatives, fetchReviewSignals,
  fetchActivitiesBookableInMonth,
  type PlannerCache, type RealTour,
} from '@/lib/planner/data';
import {
  fetchForecastDays, tripForecastWindow, computeQualityScore, assessHealthCompatibility,
} from '@/lib/planner/intelligence';
import { lodgingIncluded } from '@/lib/planner/lodging-included';
import { tourDaySpan } from '@/lib/planner/tour-span';
import { activityMode, type ActivityMode } from '@/lib/planner/day-mode';
import { rankByLoad, firstOverLimit, overLimitText, dateOfTripDay, type PlaceLoad } from '@/lib/planner/flow-balance';
import { fetchCandidateLoads, fetchTourLoads } from '@/lib/planner/place-load';

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
  type: 'permit' | 'season' | 'safety' | 'children' | 'fitness' | 'duration' | 'weather' | 'license' | 'seasickness' | 'crowd' | 'mchs';
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
  crowdScore?: number;          // 0-100: how crowded this zone is during trip dates
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

// ── Zone travel graph ────────────────────────────────────────────────────────

export interface ZoneEdge {
  distanceKm: number;
  travelHours: number | null;   // null = no road, helicopter only
  transports: TransportType[];
  costPerPerson: [number, number];  // [economy, comfort]
  needsTravelDay: boolean;
}

export const ZONE_GRAPH: Record<ZoneId, Partial<Record<ZoneId, ZoneEdge>>> = {
  avachinsky: {
    western:  { distanceKm: 300, travelHours: 7,    transports: ['jeep'],       costPerPerson: [5000, 8000],   needsTravelDay: true },
    eastern:  { distanceKm: 250, travelHours: 5,    transports: ['jeep', 'helicopter'], costPerPerson: [5000, 15000], needsTravelDay: true },
    northern: { distanceKm: 400, travelHours: null,  transports: ['helicopter'], costPerPerson: [0, 0],         needsTravelDay: false },
  },
  western: {
    avachinsky: { distanceKm: 300, travelHours: 7,   transports: ['jeep'],       costPerPerson: [5000, 8000],   needsTravelDay: true },
    eastern:    { distanceKm: 500, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0],         needsTravelDay: true },
    northern:   { distanceKm: 600, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0],         needsTravelDay: true },
  },
  eastern: {
    avachinsky: { distanceKm: 250, travelHours: 5,   transports: ['jeep', 'helicopter'], costPerPerson: [5000, 15000], needsTravelDay: true },
    western:    { distanceKm: 500, travelHours: null, transports: ['helicopter'],         costPerPerson: [0, 0],        needsTravelDay: true },
    northern:   { distanceKm: 200, travelHours: null, transports: ['helicopter'],         costPerPerson: [0, 0],        needsTravelDay: false },
  },
  northern: {
    avachinsky: { distanceKm: 400, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0], needsTravelDay: false },
    eastern:    { distanceKm: 200, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0], needsTravelDay: false },
    western:    { distanceKm: 600, travelHours: null, transports: ['helicopter'], costPerPerson: [0, 0], needsTravelDay: true },
  },
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
    sleepsIn: 'avachinsky',
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
async function fetchSafetyAlerts(arrivalDate?: string, departureDate?: string): Promise<SafetyAlert[]> {
  try {
    const params: string[] = [];
    let dateFilter = '';
    if (arrivalDate && departureDate) {
      params.push(arrivalDate, departureDate);
      dateFilter = `AND (active_until IS NULL OR active_until >= $1::date)
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

function getTripDays(profile: TripProfile): number {
  if (!profile.arrivalDate || !profile.departureDate) return 0;
  const diff = new Date(profile.departureDate).getTime() - new Date(profile.arrivalDate).getTime();
  return Math.max(0, Math.round(diff / 86400000));
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

function collectWarnings(
  profile: TripProfile,
  zones: ZoneRecommendation[],
  tripDays: number,
  crowdLoad: number = 0,
  alerts: SafetyAlert[] = [],
  /** Открытое каталогом на этот месяц; `null` — каталог спросить не вышло. */
  catalogueOpen: Set<string> | null,
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
  if (tripDays > 0 && tripDays < 5) {
    warnings.push({
      type: 'duration', severity: 'important',
      message: `${tripDays} дня — очень мало для Камчатки. Перелёт 8-9 часов из Москвы + джетлаг (UTC+12). Рекомендуем минимум 7 дней.`,
    });
  }

  // Season warnings per activity
  for (const interest of profile.interests) {
    const c = ACTIVITY_CONSTRAINTS[interest];
    if (!c) continue;
    if (!inSeason(interest, month, catalogueOpen)) {
      warnings.push({
        type: 'season', severity: 'critical',
        message: `${interest}: недоступно в выбранный период. ${c.seasonNote ?? ''}`.trim(),
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
          message: `${interest}: минимальный возраст ${c.minChildAge} лет, ребёнку ${youngest}.${alt}`,
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
        message: `${interest}: требуется уровень "${c.fitnessRequired}", у вас "${profile.fitnessLevel}". ${c.safetyNotes?.[0] ?? ''}`.trim(),
      });
    }
  }

  // Permits
  for (const zr of zones) {
    const permits = ZONE_PERMITS[zr.zone];
    if (!permits) continue;
    for (const p of permits) {
      warnings.push({
        type: 'permit', severity: 'critical',
        message: `${ZONE_NAMES[zr.zone]}: требуется ${p.name}. Оформление за ${p.advanceDays} дней. ${p.note}`,
      });
    }
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
  const remoteZones = zones.filter(z => z.zone !== 'avachinsky');
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
  if (profile.mobilityLevel === 'wheelchair') {
    warnings.push({
      type: 'safety', severity: 'critical',
      message: 'Камчатка имеет крайне ограниченную безбарьерную инфраструктуру. Доступные варианты: термальные источники Паратунки, обзорные вертолётные экскурсии.',
    });
  } else if (profile.mobilityLevel === 'limited') {
    warnings.push({
      type: 'fitness', severity: 'important',
      message: 'Ограниченная подвижность: маршруты адаптированы, исключены многочасовые переходы и крутые подъёмы.',
    });
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
    // Capacity check: penalize overloaded zones
    if (profile.arrivalDate && profile.departureDate) {
      const cap = await fetchZoneCapacity(zone, profile.arrivalDate, profile.departureDate, cache);
      if (cap.utilizationPercent > 80) {
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
      crowdScore: 0,
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
}

async function generateDayPlans(
  profile: TripProfile,
  zones: ZoneRecommendation[],
  tripDays: number,
  cache: PlannerCache,
  /** Открытое каталогом на этот месяц; `null` — каталог спросить не вышло. */
  catalogueOpen: Set<string> | null,
): Promise<DayPlanResult> {
  const unchecked = new Set<string>();
  if (tripDays <= 0 || zones.length === 0) return { days: [], unchecked: [], spanUnknown: [], tooLong: [], overLimit: [] };
  const youngest = youngestChild(profile);
  const month = getMonth(profile);

  const days: DayPlan[] = [];
  let dayNum = 1;

  // ── Day 1: Arrival ──
  const arrHour = profile.flightArrivalTime
    ? parseInt(profile.flightArrivalTime.split(':')[0], 10)
    : 14;

  let arrivalTitle: string;
  if (arrHour < 12) {
    arrivalTitle = 'Прилёт утром. Размещение, отдых. Вечер: термальные источники Паратунки';
  } else if (arrHour < 17) {
    arrivalTitle = 'Прилёт днём. Размещение, акклиматизация. Прогулка по городу';
  } else {
    arrivalTitle = 'Прилёт вечером. Размещение, ужин, отдых с дороги';
  }

  days.push({
    day: dayNum++, type: 'arrival', zone: 'avachinsky',
    title: arrivalTitle,
    description: 'Перелёт 8-9 часов. Разница с Москвой +9 часов. Акклиматизация обязательна.',
    activityType: 'hot_spring', priceFrom: 0, priceTo: 3000,
    coords: PKC_COORDS, defaultTransport: 'walking',
    allowedTransports: ['walking'], difficulty: 'easy',
    childFriendly: true, minChildAge: 0, dayWarnings: [],
  });

  if (dayNum > tripDays) return { days, unchecked: [...unchecked], spanUnknown: [], tooLong: [], overLimit: [] };

  // ── Active days budget ──
  const departureDays = 1;
  const activeBudget = tripDays - 1 - departureDays; // minus arrival, minus departure

  // Determine zone allocation
  const zoneBlocks: Array<{ zone: ZoneId; interests: string[]; activeDays: number }> = [];
  const totalScore = zones.reduce((s, z) => s + z.score, 0) || 1;

  for (const z of zones) {
    const zoneInterests = profile.interests.filter(i => {
      const c = ACTIVITY_CONSTRAINTS[i];
      return c?.bestZones.includes(z.zone) && inSeason(i, month, catalogueOpen);
    });
    if (zoneInterests.length === 0) continue;
    const rawDays = Math.max(1, Math.round((z.score / totalScore) * activeBudget));
    zoneBlocks.push({ zone: z.zone, interests: zoneInterests, activeDays: rawDays });
  }

  // Normalize to active budget
  let totalAllocated = zoneBlocks.reduce((s, b) => s + b.activeDays, 0);
  while (totalAllocated > activeBudget && zoneBlocks.length > 1) {
    const last = zoneBlocks[zoneBlocks.length - 1];
    if (last.activeDays > 1) { last.activeDays--; totalAllocated--; }
    else { zoneBlocks.pop(); totalAllocated--; }
  }
  while (totalAllocated < activeBudget && zoneBlocks[0]) {
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

    // Travel day if zone changes
    if (block.zone !== prevZone && dayNum <= tripDays - departureDays) {
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
        if (dayNum > tripDays - departureDays) break;
      }
    }

    // Fetch real operator tours (sorted by rating) + DB routes as fallback
    const primaryInterest = block.interests[0];
    const toursOrNull = await fetchRealToursForZone(block.zone, primaryInterest, block.activeDays + 2, cache);
    const realTours = toursOrNull ?? [];

    const routesOrNull = realTours.length >= block.activeDays
      ? []
      : await fetchRoutesForZone(block.zone, primaryInterest, block.activeDays - realTours.length + 2);
    let dbRoutes = routesOrNull ?? [];

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
          const slots = await fetchAvailabilityForTour(
            realTour.tourId, profile.arrivalDate, profile.departureDate, cache
          );
          if (slots.length > 0) {
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
        used += 1;
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

  // ── Travel back to Avachinsky if last zone was not avachinsky ──
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
    }
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
      childFriendly: true, minChildAge: 0, dayWarnings: [],
      // Город пешком — самостоятельный день, тура за ним нет.
      activityMode: 'self',
    });
  }

  // ── Last day: Departure ──
  if (dayNum <= tripDays) {
    const depHour = profile.flightDepartureTime
      ? parseInt(profile.flightDepartureTime.split(':')[0], 10)
      : 12;
    const depTitle = depHour >= 17
      ? 'Утро свободно. Лёгкая прогулка. Трансфер в аэропорт, вылет вечером'
      : depHour >= 12
        ? 'Сборы утром. Трансфер в аэропорт, вылет днём'
        : 'Ранний подъём. Трансфер в аэропорт, вылет утром';

    days.push({
      day: dayNum, type: 'departure', zone: 'avachinsky',
      title: depTitle,
      description: 'Аэропорт Елизово (PKC). Трансфер 30 мин из Петропавловска.',
      activityType: 'departure', priceFrom: 0, priceTo: 2500,
      coords: PKC_COORDS, defaultTransport: 'walking',
      allowedTransports: ['walking'], difficulty: 'easy',
      childFriendly: true, minChildAge: 0, dayWarnings: [],
    });
  }

  return { days, unchecked: [...unchecked], spanUnknown: [...spanUnknown], tooLong: [...tooLong], overLimit: [...overLimit] };
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
  let accFrom = 0;
  let accTo = 0;
  for (const day of days) {
    if (day.type === 'departure') continue;
    if (day.realTour?.lodgingIncluded === true) continue;
    // В зоне не ночуют — ночь считается там, где ночуют на самом деле.
    const sleepZone = ZONE_ACCOMMODATION[day.zone].sleepsIn ?? day.zone;
    const acc = ZONE_ACCOMMODATION[sleepZone];
    const nightPrice = acc.pricePerNight[bi] || acc.pricePerNight[0];
    accFrom += Math.round(nightPrice * 0.8);
    accTo   += Math.round(nightPrice * 1.2);
  }
  if (nightCount === 0) { accFrom = 0; accTo = 0; }

  // Transport — travel days + transfers
  const travelDays = days.filter(d => d.type === 'travel');
  const transFrom = travelDays.reduce((s, d) => s + d.priceFrom, 0) + 2500; // arrival transfer
  const transTo   = travelDays.reduce((s, d) => s + d.priceTo, 0) + 5000;   // both transfers

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

export async function recommendTrip(profile: TripProfile): Promise<TripRecommendation> {
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
  const warnings = collectWarnings(profile, zones, tripDays, 0, alerts, catalogueOpen);

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
  const { days, unchecked, spanUnknown, tooLong, overLimit } = await generateDayPlans(profile, zones, tripDays, cache, catalogueOpen);

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

  try {
    const aiPrompt = buildAIPrompt(profile, zones, days, warnings);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Ты ассистент по туристическому планированию Камчатки.' },
      { role: 'user', content: aiPrompt },
    ];
    const aiResponse = await callAIWithModelDirect(messages, getModelForAgent('planner'));
    if (aiResponse?.trim()) itinerary = aiResponse;
  } catch {
    // fallback already set
  }

  return {
    zones, days, warnings, priceBreakdown, itinerary,
    catalogueOpen: catalogueOpen ? [...catalogueOpen] : null,
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
