import type { DescriptionSource } from '@/lib/text/description-source';
export interface PlaceSafety {
  difficultyLevel: number | null;
  altitudeM: number | null;
  altitudeDiffM: number | null;
  distanceKm: number | null;
  terrainType: string | null;
  roadType: string | null;
  roadAccessibility: number | null;
  nearestMedicalKm: number | null;
  emergencyAccess: string | null;
  phoneRangerMches: string | null;
  satCommunicatorRequired: boolean | null;
  rulesRequired: string | null;
  weatherThreshold: Record<string, unknown> | null;
  hazardTypes: string[];
  capacityPerDay: number | null;
  optimalGroupSize: number | null;
  openFromDate: string | null;
  openToDate: string | null;
  requiredGear: string[];
  connectivity: Record<string, unknown> | null;
  registrationRequired: boolean;
  medicalInfo: string | null;
}

export interface PlaceRealtime {
  isOpen: boolean | null;
  currentCrowds: number | null;
  currentWeather: Record<string, unknown> | null;
  activeAlerts: string[] | null;
  alertSeverity: number | null;
  alertMessage: string | null;
  touristsToday: number | null;
  touristsHour: number | null;
  updatedAt: string | null;
}

export interface VolcanoAccStatus {
  colorCode: string;            // green | yellow | orange | red
  ashHeightM: number | null;
  summary: string | null;
  sourceUrl: string | null;
  observedAt: string | null;
}

export interface PlaceRoute {
  id: string;
  title: string;
  activityType: string | null;
  difficulty: string | null;
  distanceKm: number | null;
  durationHours: number | null;
}

export interface NearbyPlace {
  id: string;
  name: string;
  locationType: string | null;
  lat: number;
  lng: number;
  distanceKm: number;
  thumbUrl: string | null;
}

export interface PlaceReview {
  id: string;
  rating: number;
  comment: string | null;
  authorName: string;
  createdAt: string;
}

export interface PlaceTour {
  id: string;
  title: string;
  basePrice: number;
  durationDays: number | null;
  operatorName: string;
  operatorSlug: string | null;
}

export interface PlaceEco {
  zone: 'UNESCO' | 'federal_reserve' | 'regional_reserve' | 'natural_park' | 'zakaznik' | 'none' | null;
  permitRequired: boolean;
  rules: string | null;
  permitUrl: string | null;
}

export interface PlaceIndigenous {
  peoples: string[];
  localName: string | null;
  sacred: boolean;
  traditionalUse: string | null;
  respectNotes: string | null;
}

export interface PlacePhotoAttribution {
  author: string | null;
  license: string | null;
  licenseUrl: string | null;
  sourceUrl: string | null;
}

export interface PlaceData {
  id: string;
  name: string;
  description: string | null;
  /**
   * Откуда взят ТЕКСТ описания (#1830). null — подписывать нечего: либо
   * текст не из внешнего источника, либо его с тех пор переписали.
   */
  descriptionSource: DescriptionSource | null;
  essence: string | null;
  category: string | null;
  locationType: string | null;
  lat: number;
  lng: number;
  zone: string | null;
  district: string | null;
  photoUrl: string | null;
  images: unknown[];
  photoCount: number;
  photoAttribution: PlacePhotoAttribution | null;
  bestSeason: string | null;
  seasonalNotes: Record<string, string> | null;
  accessInfo: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  updatedAt: string | null;
  kuzmichReview: string | null;
  eco: PlaceEco | null;
  indigenous: PlaceIndigenous | null;
  safety: PlaceSafety;
  realtime: PlaceRealtime | null;
  volcanoStatus: VolcanoAccStatus | null;
  routes: PlaceRoute[];
  tours: PlaceTour[];
  reviews: PlaceReview[];
  nearby: NearbyPlace[];
}

/**
 * Типы мест — НЕ здесь. Один список на платформу:
 * `lib/places/location-types.ts` (перепись 19.09: копий было пять, ни одна не
 * знала всех 24 ключей). Имя сохранено ради импортёров.
 */
export { LOCATION_TYPES as LOCATION_TYPE_LABELS } from '@/lib/places/location-types';

/**
 * Названия опасностей — НЕ здесь. Один список на платформу:
 * `lib/safety/hazard-labels.ts` (перепись 19.09: копий было шесть, и все
 * шесть разошлись; контекст Кузьмича, например, не знал ключа `bears`).
 *
 * Имя и форма сохранены ради импортёров (`HAZARD_LABELS[h]?.label`), но
 * значение теперь общее.
 */
export { HAZARDS as HAZARD_LABELS } from '@/lib/safety/hazard-labels';

export const DIFFICULTY_LABELS = ['', 'Лёгкий', 'Ниже среднего', 'Средний', 'Сложный', 'Экстремальный'];
