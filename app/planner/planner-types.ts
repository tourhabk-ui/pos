/**
 * Planner types — shared between PlannerClient and extracted components.
 */

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
   * Тур дня от движка. Здесь — только то, что читает экран подбора жилья:
   * включено ли проживание (true / false / null — не знаем).
   */
  realTour?: { lodgingIncluded: boolean | null };
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
  zones: Array<{ zone: string; score: number; reason: string; crowdScore?: number }>;
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

export interface RoutePoint {
  id: string;
  title: string;
  description: string | null;
  lat: number;
  lng: number;
  activity_type: string | null;
  location_type: string | null;
  zone: string | null;
}

export interface Partner {
  id: string;
  name: string;
  slug: string;
  rating: number;
  review_count: number;
  short_description: string;
  contacts: Array<{ name: string; phone: string; role: string }> | null;
  has_matching_tours: boolean;
}

export interface TourPreview {
  id: string;
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
}

export interface LodgingStayView {
  zone: string;
  zoneName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  result: ExtrasOutcome<LodgingOptionView>;
}

export interface TransferOptionView {
  id: string;
  tripDate: string;
  departureNote: string | null;
  fromText: string;
  toText: string;
  seatsFree: number;
  seatsTotal: number;
  pricePerSeat: number | null;
  vehicleKind: string;
  vehicleTitle: string;
  partnerName: string;
}

export interface TripExtrasData {
  lodging?:
    | { state: 'no_dates' }
    | { state: 'checked'; stays: LodgingStayView[]; nightsInTours: number; unzonedCount: number | null };
  transfer?:
    | { state: 'no_dates' }
    | { state: 'window_too_long'; window: { from: string; to: string; seats: number }; maxDays: number }
    | (ExtrasOutcome<TransferOptionView> & { window: { from: string; to: string; seats: number } });
  car?: { state: 'not_offered'; message: string; hint: string };
}
