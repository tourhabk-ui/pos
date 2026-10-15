import type { CoordSource } from '@/lib/places/coord-source';
import type { DescriptionSource } from '@/lib/text/description-source';
import type { SafetyProfileSource } from '@/lib/safety/profile-source';
export interface PlaceSafety {
  /**
   * Откуда взялся профиль: `type_template` — выведено из location_type
   * миграцией 070/0645 и не измерено (такие значения API не отдаёт вовсе),
   * `manual` — записал человек, `unknown`/`null` — не установлено.
   * Правило показа — lib/safety/profile-source.ts.
   */
  source: SafetyProfileSource | null;
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
  /** Природоохранный лимит места в сутки (places.visitor_limit_per_day, 1017); null — не установлен. */
  capacityPerDay: number | null;
  /** Чья это норма: приказ парка, квота заповедника, решение владельца. */
  capacityPerDaySource?: string | null;
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
  /** Вердикт пересчёта сводок (safety-ingest): red / yellow / green; читать через placeDayStatus. */
  status: string | null;
  /** Вулканы, к которым место привязано поимённо (1029): их шкалы поднимают статус места. */
  linkedVolcanoes: string | null;
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
  /** id в пространстве VIEW — COALESCE(ark_id, id), как ищет /routes/[id]. */
  id: string;
  /** ЧПУ маршрута; null — адрес только по id. */
  slug: string | null;
  title: string;
  activityType: string | null;
  difficulty: string | null;
  distanceKm: number | null;
  durationHours: number | null;
  /**
   * Род связи (миграция 874, §4.1): `nearby` — «в 15 км от центра маршрута»
   * (миграция 167), через место маршрут НЕ идёт. Нет поля — не размечено.
   */
  linkKind?: 'waypoint' | 'nearby' | 'unknown' | null;
}

export interface NearbyPlace {
  id: string;
  /** ЧПУ места; null — ссылка по id (аудит 01.10: UUID уходил редиректом 308). */
  slug: string | null;
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
  /** Адрес карточки тура (ЧПУ, 1114). */
  slug: string | null;
  title: string;
  basePrice: number;
  durationDays: number | null;
  operatorName: string;
  operatorSlug: string | null;
  /** partners.is_public — открыта ли страница оператора; null — не прочитано (13.10). */
  operatorPublic: boolean | null;
  /**
   * Чем тур связан с местом (§4.1): `main_place` — место названо главным
   * местом тура (operator_tours.main_place_id, 1286: точное совпадение
   * координат или выбор оператора); `waypoint` — маршрут тура размечен через
   * место точкой пути; `unknown` — связь маршрута есть, но проходит ли он
   * через само место, не установлено. «Рядом» сюда не попадает вовсе.
   */
  linkKind: 'main_place' | 'waypoint' | 'unknown';
}

export interface PlaceEco {
  zone: 'UNESCO' | 'federal_reserve' | 'national_park' | 'regional_reserve' | 'natural_park' | 'zakaznik' | 'nature_monument' | 'none' | null;
  /**
   * null — не записано (14.10, миграция 1256): у памятника природы известен
   * режим, а положения о нём нет, и нужно ли разрешение — неизвестно. Прежде
   * загрузчик делал из NULL `false`, и строка «Разрешение» отвечала «не
   * требуется» (`permitNotRequired`) там, где этого никто не записывал.
   */
  permitRequired: boolean | null;
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

/** Права кадра галереи — то, что к автору добавляет подпись (15.10). */
export type PlacePhotoRights = Omit<PlacePhotoAttribution, 'author'>;

export interface PlaceData {
  id: string;
  name: string;
  description: string | null;
  /**
   * Откуда взят ТЕКСТ описания (#1830). null — подписывать нечего: либо
   * текст не из внешнего источника, либо его с тех пор переписали.
   */
  descriptionSource: DescriptionSource | null;
  /**
   * Описание снято с карточки как путевая заметка от первого лица и ждёт
   * переписи по источникам (миграция 1247). Не путать с «описания нет»:
   * об этом карточка говорит словами.
   */
  descriptionWithdrawn?: boolean;
  essence: string | null;
  category: string | null;
  locationType: string | null;
  lat: number;
  lng: number;
  /** Откуда координата: снята, угадана по названию, заглушка, справочник, не записано. */
  coordSource?: CoordSource;
  /** Описание последним записала модель, и текст с тех пор не менялся (журнал 911). */
  descriptionByModel?: boolean;
  /**
   * Описание написано голосом впечатления («тишина», «запах», «чувствуешь» —
   * lib/places/description-voice) и источника у него не записано. Кузьмич и
   * MCP отдают такой текст с пометкой с 26.09; карточка — тоже (15.10).
   */
  descriptionImpression?: boolean;
  zone: string | null;
  district: string | null;
  photoUrl: string | null;
  images: unknown[];
  photoCount: number;
  photoAttribution: PlacePhotoAttribution | null;
  /**
   * Автор каждого своего кадра по его адресу в images (04.10). Подпись под
   * фото называет автора того кадра, что на экране; null — автора не знаем.
   */
  photoCredits: Record<string, string | null>;
  /**
   * Лицензия и страница файла кадра галереи по его адресу (15.10) — только у
   * кадров, где они записаны. Нет записи — подпись называет одного автора.
   * Необязательное: офлайн-кэш карточки мог лечь до этого поля.
   */
  photoRights?: Record<string, PlacePhotoRights>;
  bestSeason: string | null;
  seasonalNotes: Record<string, string> | null;
  accessInfo: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  updatedAt: string | null;
  kuzmichReview: string | null;
  /** Статьи «Летописи Камчатки» об этом месте (lib/chronicle) — только адрес и заголовок. */
  chronicle: Array<{ slug: string; title: string }>;
  eco: PlaceEco | null;
  indigenous: PlaceIndigenous | null;
  safety: PlaceSafety;
  realtime: PlaceRealtime | null;
  volcanoStatus: VolcanoAccStatus | null;
  routes: PlaceRoute[];
  tours: PlaceTour[];
  reviews: PlaceReview[];
  /** Сводка по всем отзывам места (а не по показанным десяти). */
  reviewsSummary?: { total: number; avg: number | null };
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
