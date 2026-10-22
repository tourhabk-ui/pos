/**
 * Planner types — shared between PlannerClient and extracted components.
 */

import type { StayPrice } from '@/lib/planner/trip-extras';
import type { PlannerRoute } from '@/lib/planner/bg-routes';

export type TransportType = 'walking' | 'jeep' | 'helicopter' | 'boat';
export type DayType = 'arrival' | 'activity' | 'travel' | 'rest' | 'buffer' | 'departure';
export type FitnessLevel = 'beginner' | 'moderate' | 'active';
export type BudgetTier = 'economy' | 'comfort' | 'premium';
export type MobileTab = 'plan' | 'map';

export interface SelectItem {
  id: string;
  label: string;
  Icon: React.ElementType;
}

export interface DayPlan {
  day: number;
  type: DayType;
  zone: 'avachinsky' | 'western' | 'eastern' | 'northern';
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
  /** Род активного дня — производит движок (lib/planner/day-mode). */
  activityMode?: 'operator' | 'self' | 'open';
  /**
   * Тур дня от движка. Здесь — только то, что читает клиент: включено ли
   * проживание (экран подбора жилья), id тура — по нему общие правила
   * правки (lib/planner/plan-ops) держат дни многодневного тура вместе, — и
   * единица цены с вместимостью группы: по ним смета на группу считает тур
   * (lib/planner/estimate, #2304).
   */
  realTour?: {
    tourId: string; lodgingIncluded: boolean | null; priceUnit?: string; maxParticipants?: number;
    /** Оператор тура — уходит в заявку на весь план (#2304, шаг 2). */
    operatorName?: string;
    /** Дни тура по правилу брони — для цены «за день на человека». */
    durationDays?: number;
    /** Почему цена отличается от заголовочной: «−15%, последние места». */
    priceLabel?: string;
  };
  /** Цена тура за единицу по правилу брони — у первого дня тура (смета, #2304). */
  realPrice?: number;
  /** Цены тура для этой группы нет, и почему (группа вне ступеней цены). */
  priceMissing?: string;
  /** Ближайшая свободная дата тура в окне поездки (от движка). */
  availableDate?: string;
}

export interface TripWarning {
  type: string;
  severity: 'critical' | 'important' | 'info';
  message: string;
}

export interface PriceBreakdown {
  activities: [number, number];
  accommodation: [number, number];
  transport: [number, number];
  perPersonTotal: [number, number];
}

export interface Recommendation {
  zones: Array<{ zone: string; score: number; reason: string; crowdScore?: number | null }>;
  days: DayPlan[];
  warnings: TripWarning[];
  priceBreakdown: PriceBreakdown;
  itinerary: string;
  /** Как исполнены стиль поездки и дни отдыха (движок, lib/planner/travel-style). */
  preferences?: {
    travelStyle: 'self' | 'operator' | 'mixed';
    restDaysRequested: number;
    restDaysPlanned: number;
    notes: Array<{ topic: 'travel_style' | 'rest_days'; status: 'honoured' | 'partial' | 'not_honoured'; message: string }>;
  };
}

/**
 * Маршрут фоновой точки карты. Форма — разбор ответа каталога
 * (lib/planner/bg-routes, toPlannerRoute): до 22.10 здесь была своя копия
 * со snake_case полями, а ответ приводился к ней вслепую, и поля, которых
 * каталог так не называет, были пустыми всегда.
 */
export type RoutePoint = PlannerRoute;

export interface Partner {
  id: string;
  name: string;
  slug: string;
  /** partners.is_public — страница оператора открыта (ссылка строится одним правилом). */
  is_public?: boolean | null;
  rating: number;
  review_count: number;
  short_description: string;
  /** partners.contacts — JSONB без гарантии формы: массив людей или объект каналов. */
  contacts: unknown;
  has_matching_tours: boolean;
}

export interface TourPreview {
  id: string;
  /** Адрес карточки (ЧПУ, миграция 1114); null — ссылка по числу. */
  slug: string | null;
  title: string;
  base_price: string;
  price_unit: string | null;
  operator_slug: string;
}

export interface ValidationResult {
  valid: boolean;
  message: string;
}

/** Что ещё нужно к поездке — ответ /api/planner/trip-extras. */
export type ExtrasOutcome<T> =
  | { state: 'ok'; items: T[] }
  | { state: 'empty' }
  | { state: 'unavailable' };

export interface LodgingOptionView {
  id: string;
  name: string;
  type: string;
  priceFrom: number | null;
  rating: number | null;
  reviewCount: number;
  isVerified: boolean;
  /**
   * Цена стоянки на всю группу по правилу брони (lib/planner/trip-extras).
   * Нет — ответ сервера старше экрана: показывается «от … за ночь».
   */
  stay?: StayPrice;
}

export interface LodgingStayView {
  zone: string;
  zoneName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  result: ExtrasOutcome<LodgingOptionView>;
}

/** Перевозчик «под заказ» — машина целиком (форма lib/planner/trip-extras-data, CharterOffer). */
export interface CharterOfferView {
  slug: string;
  name: string;
  fleet: string | null;
  priceFromRub: number | null;
  destinations: number;
  /**
   * Цена за час и за полный день (1292); null — такой цены нет. Поля может не
   * быть вовсе: план, сохранённый офлайн до 1292, пришёл без них — это «нет
   * такой цены», а не «не число ₽ в час».
   */
  hourRub?: number | null;
  dayRub?: number | null;
}

export interface TripExtrasData {
  lodging?:
    | { state: 'no_dates' }
    | { state: 'checked'; stays: LodgingStayView[]; nightsInTours: number; unzonedCount: number | null };
  transfer?: ExtrasOutcome<CharterOfferView>;
  car?: { state: 'not_offered'; message: string; hint: string };
}
