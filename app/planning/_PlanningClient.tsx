'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import Image from 'next/image';
import {
  Check, ChevronRight, ChevronLeft, Navigation, MapPin,
  Map as MapIcon, CloudSun, Phone,
  AlertCircle, Wifi, WifiOff, X, ExternalLink, Download, Bot, Users,
  Trash2, Binoculars, MapPinPlus, Square, Route, Crosshair,
} from 'lucide-react';
import { FieldActionBar, type FieldAction } from '@/components/field/FieldActionBar';
import { useTrackRecorder } from '@/hooks/useTrackRecorder';
import { ObservationSheet, useTrailObservationQueue } from '@/components/field/ObservationSheet';
import { useOfflineRegion } from '@/lib/offline/useOfflineRegion';
import { MarkerType, type MapMarker, type MapMarkerGeometry } from '@/components/shared/leaflet-types';
import { isScatteredCollection } from '@/lib/routes/geometry-compact';
import { approachPlan, ON_ROUTE_ENTRY_KM } from '@/lib/on-route/approach';
import { advanceAlong, type AlongState } from '@/lib/on-route/projection-window';
import { offTrackThresholdM, fixUsableForNavigation } from '@/lib/on-route/fix-quality';
import {
  etaHours, formatEta, paceFromTrack, routeProgress,
  type TravelMode, type TrackSample,
} from '@/lib/on-route/eta';
import {
  fixInfo, fixLabel, figuresAreLive, canAdvanceWaypoint,
  readHeading, compassLabel, compassNeedsPermission, fixAccuracyPlausible,
  type CompassState,
} from '@/lib/on-route/fix-quality';
import { remainingRelief, distanceAlongTrack } from '@/lib/routes/relief';
import { connectivityState } from '@/lib/on-route/connectivity';
import {
  trackFidelityLabel, trackFidelityStyle, type TrackFidelity,
} from '@/lib/routes/track-fidelity';
import { addCrumb, parseCrumbs, serializeCrumbs, crumbsKey, type Crumb } from '@/lib/offline/breadcrumbs';
import { connectorLine, CONNECTOR_TITLES, trackLine, calculatedCarLine } from '@/lib/map/line-standard';
import {
  calculatedCarToLeafletCoordinates, type CalculatedCarRoute,
} from '@/lib/on-route/calculated-route';
import {
  parseSavedMap, savedMapKey, savedMapSummary, requestPersistentStorage,
  type SavedMapRecord,
} from '@/lib/offline/saved-map';
import { MCHS_ONLINE_FORM_URL } from '@/lib/safety/mchs-registration';
import { useSwRegistration } from '@/lib/offline/sw-status';
import {
  passportGradeLabel, passportGradeNote, type PassportGrade,
} from '@/lib/routes/passport';
import { navigabilityCtaLabel, type NavigabilityVerdict } from '@/lib/routes/navigability';
import { groupRoutesByDestination, type Destination, type DestinationOption, type RouteOption } from '@/lib/on-route/destination';
import { originLabel, type Origin } from '@/lib/on-route/origin';
import { httpRouteBuilder, type RouteBuildResult, type RouteBuildMode } from '@/lib/on-route/route-build';

/** Вердикт черты в том виде, в каком он приходит с сервера. */
interface PreviewNavigability {
  verdict: NavigabilityVerdict;
  canLead: boolean;
  reasons: string[];
}
import {
  saveFieldPack, loadFieldPack, removeFieldPack, verifyFieldPack, fieldPackReadiness, formatSnapshotAge,
  type FieldPackManifest, type PackAssetState, type PackSafetySnapshot,
} from '@/lib/offline/field-pack';
import { RouteProgressBar } from '@/components/field/RouteProgressBar';
import { FieldCorridor } from '@/components/field/FieldCorridor';
import { TrustCard } from '@/components/field/TrustCard';
import { RecoveryCard } from '@/components/field/RecoveryCard';
import { recoveryState } from '@/lib/on-route/recovery';
import { EmergencyAction } from '@/components/shared/EmergencyAction';
import { FieldCompass } from '@/components/field/FieldCompass';
import { FieldStatusStrip } from '@/components/field/FieldStatusStrip';
import { plural } from '@/lib/home/data-freshness';
import { FieldDistance } from '@/components/field/FieldDistance';
import { bearingDeg } from '@/lib/on-route/bearing';

const Header = dynamic(
  () => import('@/components/layout/Header').then(m => ({ default: m.Header })),
  { ssr: false }
);

// Карта с треком — только на клиенте (Leaflet не SSR-безопасен)
// Карта грузится отдельным куском (leaflet + markercluster). Без подписи
// нажатие на кнопку выглядело зависанием: чёрный экран на всё время загрузки
// чанка и первых тайлов, и ни одного признака, что что-то происходит
// (владелец 09.08: «карта открывается с большой задержкой»).
const NavigateTo = dynamic(() => import('@/components/shared/NavigateTo'), { ssr: false });

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center"
      style={{ background: '#0d1117', color: 'var(--text-muted)', fontSize: 13 }}>
      Загружаем карту…
    </div>
  ),
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

interface RoutePreview {
  id: string;
  title: string;
  difficulty: string | null;
  durationDays: number | null;
  distanceKm: number | null;
  imageUrl: string | null;
  /** Через какие места проходит (для выбора по названию места) */
  via?: string | null;
  /**
   * Род навигационных данных (Трек / Набросок / Точки…) — виден ДО выбора:
   * различение снятого трека и ломаной — главная защита платформы, и она
   * не должна открываться человеку только в поле (план FCN, этап 1).
   */
  lineGrade?: PassportGrade | null;
  /** Все места пути — для группировки выбора по МЕСТУ (владелец 20.08). */
  waypointNames?: string[];
  /** Набор высоты — участвует в сравнении путей (владелец 21.08). */
  elevationGainM?: number | null;
  /**
   * Личность путевых точек параллельно waypointNames — id/координаты
   * places, не только имя (владелец 27.08: домен `Destination` требует
   * `id/lat/lon` настоящего места). См. lib/on-route/destination.ts.
   */
  waypointIds?: (string | null)[];
  waypointLats?: (number | null)[];
  waypointLngs?: (number | null)[];
  /**
   * Посчитанный автомобильный путь (владелец 28.08, PR рендеринга поверх
   * 5B-1) — заполнен только у синтетического варианта из RouteBuildResult
   * `found` с mode: 'car'. Не путать с каталожным маршрутом: у него нет
   * lineGrade и нет id, по которому можно спросить /api/routes/[id] — вся
   * геометрия и метрики уже здесь, локально.
   */
  calculated?: CalculatedCarRoute;
}


/** Бейдж рода данных маршрута в выборе. Цвет — семантика, не украшение. */
function GradeChip({ grade }: { grade: PassportGrade | null | undefined }) {
  if (!grade) return null;
  const color =
    grade === 'surveyed' ? 'var(--success)'
    : grade === 'points_only' ? 'var(--ocean)'
    : grade === 'none' ? 'var(--text-muted)'
    : 'var(--warning)';
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0"
      style={{
        color,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}>
      {passportGradeLabel(grade)}
    </span>
  );
}

const DEFAULT_CHECKLIST: ChecklistItem[] = [
  // Подпись без числа: настоящий вес приходит из записи о скачанном
  // регионе и подставляется в effectiveChecklist. Константа «450 МБ» была
  // числом, которого никто не мерил, на чек-листе готовности к выходу.
  { id: 'maps',      label: 'Карты региона скачаны',       done: false },
  { id: 'mchs',      label: 'МЧС регистрация оформлена',    done: false },
  { id: 'offline',   label: 'Маршрут сохранён офлайн',      done: false },
  { id: 'emergency', label: 'Контакты экстренных служб',    done: false },
  { id: 'gear',      label: 'Проверка снаряжения',          done: false },
];

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: 'Лёгкий', medium: 'Средний', hard: 'Сложный', extreme: 'Экстремальный',
};

interface GearItem { id: string; label: string; category: string; }

const GEAR_LIST: GearItem[] = [
  { id: 'map',       label: 'Карта маршрута / GPS',   category: 'Навигация' },
  { id: 'compass',   label: 'Компас',                 category: 'Навигация' },
  { id: 'boots',     label: 'Трекинговые ботинки',    category: 'Одежда' },
  { id: 'rain',      label: 'Дождевик / мембрана',    category: 'Одежда' },
  { id: 'thermo',    label: 'Термобельё',             category: 'Одежда' },
  { id: 'fleece',    label: 'Флиска / тёплый слой',  category: 'Одежда' },
  { id: 'firstaid',  label: 'Аптечка',                category: 'Безопасность' },
  { id: 'bear',      label: 'Средство от медведей',   category: 'Безопасность' },
  { id: 'whistle',   label: 'Свисток',                category: 'Безопасность' },
  { id: 'headlamp',  label: 'Фонарик / налобный',     category: 'Безопасность' },
  { id: 'poles',     label: 'Трекинговые палки',      category: 'Снаряжение' },
  { id: 'backpack',  label: 'Рюкзак с накидкой',      category: 'Снаряжение' },
  { id: 'tent',      label: 'Палатка / бивак',        category: 'Снаряжение' },
  { id: 'water',     label: 'Запас воды (2л+)',        category: 'Еда и вода' },
  { id: 'filter',    label: 'Фильтр для воды',         category: 'Еда и вода' },
  { id: 'food',      label: 'Еда на поход',            category: 'Еда и вода' },
  { id: 'phone',     label: 'Заряженный телефон',      category: 'Связь' },
  { id: 'powerbank', label: 'Пауэрбэнк',              category: 'Связь' },
];

/**
 * Модульная константа: инлайн-литерал `center={[53.0444, 158.6483]}` в JSX
 * пересоздавал массив на КАЖДЫЙ рендер — новая identity на каждый чих
 * состояния модалки. LeafletMap пересоздаёт весь инстанс карты при смене
 * identity center/markers (см. её же комментарии), поэтому пикер точки на
 * карте «перебирал» карту непрерывно и не давал тапнуть (живой скрин
 * владельца 30.08: «невозможно что-либо сделать»). Тот же урок уже применён
 * в HomeMapPreview.tsx (HOME_MAP_CENTER) — здесь пропущен.
 */
const MAP_PICK_DEFAULT_CENTER: [number, number] = [53.0444, 158.6483];

// ─── Progress Ring ─────────────────────────────────────────────────────────────

function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 32;
  const circ = 2 * Math.PI * r;
  const offset = circ - (done / Math.max(total, 1)) * circ;
  return (
    <div className="relative flex items-center justify-center" style={{ width: 80, height: 80 }}>
      <svg className="-rotate-90" width="80" height="80" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--border)" strokeWidth="6" />
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--accent)" strokeWidth="6"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      </svg>
      <div className="absolute flex flex-col items-center leading-tight">
        <span className="text-base font-bold text-[var(--text-primary)]">{done}/{total}</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>выполнено</span>
      </div>
    </div>
  );
}

// ─── Route card (horizontal scroll) ──────────────────────────────────────────

function RouteCard({ route, onNavigate }: { route: RoutePreview; onNavigate?: (routeId: string) => void }) {
  return (
    <div
      className="flex-shrink-0 rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/40 transition-all flex flex-col"
      style={{ width: 160 }}
    >
      <Link href={`/routes/${route.id}`} className="block">
        <div className="relative h-24 bg-[var(--bg-hover)]">
          {route.imageUrl ? (
            <Image src={route.imageUrl} alt={route.title} fill sizes="160px" className="object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <MapPin className="w-6 h-6 text-[var(--text-muted)]" />
            </div>
          )}
          {route.difficulty && (
            <span className="absolute top-2 left-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
              style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
              {DIFFICULTY_LABELS[route.difficulty] ?? route.difficulty}
            </span>
          )}
        </div>
        <div className="px-2 pt-2">
          <p className="text-xs font-semibold text-[var(--text-primary)] line-clamp-2 leading-snug">{route.title}</p>
          {(route.durationDays || route.distanceKm) && (
            <p className="text-[10px] text-[var(--text-muted)] mt-1">
              {route.durationDays ? `${route.durationDays} дн` : ''}
              {route.durationDays && route.distanceKm ? ' · ' : ''}
              {route.distanceKm ? `${route.distanceKm} км` : ''}
            </p>
          )}
        </div>
      </Link>
      {onNavigate && (
        <div className="px-2 pb-2 pt-1.5 mt-auto">
          <button
            onClick={() => onNavigate(route.id)}
            className="w-full text-[10px] font-bold py-1.5 rounded-lg transition-colors"
            style={{ background: 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)' }}>
            Начать →
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Compass component ────────────────────────────────────────────────────────

/**
 * Компас рисуется уверенно ТОЛЬКО когда азимут подтверждён.
 *
 * До 09.08 стрелка выглядела одинаково всегда — в том числе на iPhone, где
 * события ориентации без разрешения не приходят вовсе и heading навечно
 * оставался нулём: человек видел уверенную стрелку, показывающую «север» при
 * любом повороте телефона. Уверенный прибор при мёртвом датчике опаснее
 * пустого экрана: пустой заставляет достать карту.
 */

// ─── Haversine distance (km) ──────────────────────────────────────────────────


/** Километры для глаз: под километром — метры, иначе десятые. */
function fmtKm(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(1)} км`;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── НА МАРШРУТЕ tab ──────────────────────────────────────────────────────────

interface SavedWaypoint { lat: number; lng: number; name: string; }

/**
 * Линия маршрута для карты — снятый трек или честный фолбэк по точкам.
 *
 * Общая точка правды для двух разных карт (Шаг 1 редизайна 29.08):
 * постоянного фона (виден всегда, требует стабильных identity markers —
 * живой скрин владельца, «карта постоянно моргает», когда фон получал ту
 * же линию, что и полноэкранный режим) и полноэкранного режима «Карта»
 * (mapMarkers ниже, где к этой же линии добавляются след и подход). Держать
 * эту логику в двух местах значило бы рано или поздно почистить дублирование
 * так, что одна копия правится, а другая — нет, ровно тот класс дефекта,
 * ради которого писался §12 CLAUDE.md для линий на карте.
 */
function computeRouteLineMarker(
  track: Array<[number, number]> | null,
  waypoints: SavedWaypoint[],
  activeRouteTitle: string | null,
  dataConflict: boolean,
  lineFidelity: TrackFidelity,
): MapMarker | null {
  const wpLine = waypoints.map(w => [w.lat, w.lng] as [number, number]);
  const fallback = wpLine.length >= 2 && !isScatteredCollection(wpLine) ? wpLine : null;
  const trackTrusted = track != null && track.length >= 2;
  const line = dataConflict ? null : (trackTrusted ? track : fallback);
  if (!line) return null;
  return {
    coords: line[0],
    title: activeRouteTitle ?? 'Маршрут',
    geometry: {
      type: 'polyline',
      coordinates: line,
      ...trackFidelityStyle(lineFidelity),
    } as MapMarkerGeometry,
    suppressBalloon: true,
  };
}

function OnTrailTab() {
  const [heading, setHeading] = useState(0);
  // Земной источник азимута, увиденный хоть раз, отменяет относительный
  // навсегда — см. подписку на события ниже.
  const sawAbsoluteRef = useRef(false);
  // Прибор обязан отличать «я знаю» от «я показываю последнее, что видел».
  const [compassState, setCompassState] = useState<CompassState>('off');
  const [coords, setCoords] = useState<{
    lat: number; lng: number; alt: number | null; accuracy: number | null; t: number;
  } | null>(null);
  // Курс по движению: GPS отдаёт course-over-ground, когда человек идёт.
  // Магнитометр врёт рядом с железом (палки, ледоруб, пауэрбанк), курс
  // движения — нет; на ходу он честнее и подхватывает прибор там, где
  // датчик не подтверждён.
  const [gpsCourse, setGpsCourse] = useState<{ heading: number; t: number } | null>(null);
  // Возраст фикса тикает сам: без этого «сигнал потерян» никогда не появится,
  // потому что новых событий от мёртвого GPS не приходит по определению.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [gpsMessage, setGpsMessage] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [isOffline, setIsOffline] = useState(false);
  const [gpsError, setGpsError] = useState(false);
  const watchRef = useRef<number | null>(null);
  // Ref so the timer closure always reads the current value without restarting sensors
  const startTimeRef = useRef(Date.now());
  const [waypoints, setWaypoints] = useState<SavedWaypoint[]>([]);
  const [currentWpIdx, setCurrentWpIdx] = useState(0);
  // След GPS для живого темпа и сам темп. Темп пересчитывается по таймеру, а
  // не на каждом тике: экран не должен дёргаться от шума позиционирования.
  const trackRef = useRef<TrackSample[]>([]);
  const [paceKmh, setPaceKmh] = useState<number | null>(null);
  // Режим движения решает всё: 31.6 км пешком и на машине — разные продукты
  // на одном экране (владелец 09.08). Выбор туриста живёт между сессиями.
  const [travelMode, setTravelMode] = useState<TravelMode>('foot');
  const [activeRouteTitle, setActiveRouteTitle] = useState<string | null>(null);
  // Профиль высот маршрута. Считает сервер по полному треку; здесь только
  // режем от текущего положения. null или reliable=false — высот в данных нет,
  // и это говорится словами (владелец 09.08: «без профиля блок декоративен»).
  const [relief, setRelief] = useState<{
    reliable: boolean; ascentM: number; descentM: number; points: { dM: number; zM: number }[];
    // Откуда высоты: из самого трека или дозаполнены моделью рельефа. У
    // модели нет ям, троп и свежих осыпей — она знает форму земли и не
    // знает пути по ней, и подпись обязана это сказать.
    source: string | null;
  } | null>(null);
  // Сам трек: по нему положение и следующая точка переводятся в шкалу профиля.
  // Без этого срез брался по прямым между точками, а профиль размечен по
  // извилистому пути — на горном маршруте это разные числа в полтора раза.
  const [track, setTrack] = useState<Array<[number, number]> | null>(null);
  // Шкала трека: метры ПОЛНОГО трека на каждую оставленную точку.
  // Без неё положение мерилось по прореженной ломаной, а профиль —
  // по полному треку, и срез рельефа уезжал к началу.
  const [trackDm, setTrackDm] = useState<number[] | null>(null);
  // Происхождение линии из данных маршрута. undefined — ответ API ещё не
  // приходил (офлайн-кэш источника не знает), null — API ответил «источник
  // не записан». Разница важна: у trackLine это два разных честных состояния.
  const [geometrySource, setGeometrySource] = useState<string | null | undefined>(undefined);
  /**
   * Когда в последний раз пришли ЖИВЫЕ данные маршрута. Нужен ступени связи:
   * «снимок от такого-то часа» — это утверждение о свежести, и брать его
   * можно только из факта успешного ответа, а не из момента открытия экрана.
   */
  const [liveDataAt, setLiveDataAt] = useState<number | null>(null);
  const [isLoadingRoute, setIsLoadingRoute] = useState(false);
  const [showRouteModal, setShowRouteModal] = useState(false);
  const [showMap, setShowMap] = useState(false);
  // Центр карты фиксируется В МОМЕНТ открытия. LeafletMap пересоздаёт карту
  // при смене identity center/markers — живые coords в center убивали карту
  // на каждом GPS-тике: тайлы не успевали грузиться (вечно-серый фон),
  // маркеры «прыгали», а «вы здесь» не отрисовывался (скрины владельца
  // 2026-07-18). Живую позицию рисует сам LeafletMap (showUserLocation).
  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>(undefined);
  const [modalRoutes, setModalRoutes] = useState<RoutePreview[]>([]);
  const [modalError, setModalError] = useState<string | null>(null);
  // Навигаторный выбор (фидбэк владельца 2026-07-19): ищем по НАЗВАНИЮ МЕСТА,
  // варианты смотрим на карте и только потом фиксируем маршрут.
  const [modalQuery, setModalQuery] = useState('');
  const [searchRoutes, setSearchRoutes] = useState<RoutePreview[]>([]);
  // Deep-link с карточки места (§9 CLAUDE.md, «Маршруты» → сюда): предзаполняет
  // то же поле поиска, что человек заполнил бы сам, — не отдельная ветка кода,
  // поэтому идёт по тем же путям/группировке/ошибкам, что и ручной ввод.
  //
  // auto=1 (владелец 30.08: «сразу на маршруте от места, где находится
  // пользователь») сверх этого доводит дело до конца САМ — цель и старт
  // отмечает первым найденным совпадением и живым GPS, а не оставляет два
  // тапа человеку. Каждый шаг — свой одноразовый ref, не state: после
  // автовыбора человек волен нажать «Изменить» и передумать, и повторный
  // рендер эффекта не обязан отменять его решение обратно.
  const cameFromPlaceRef = useRef(false);
  const autoDestConsumedRef = useRef(false);
  const autoOriginConsumedRef = useRef(false);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const q = params.get('q');
      if (q && q.trim()) {
        setModalQuery(q.trim());
        if (params.get('auto') === '1') cameFromPlaceRef.current = true;
      }
    } catch { /* параметра нет — ничего не меняем */ }
  }, []);

  // Destination-first (владелец 27.08): фиксированная карточка места, пока
  // не выбран конкретный путь к ней. null — список карточек мест, не путей.
  const [selectedDestination, setSelectedDestination] = useState<DestinationOption | null>(null);
  // Откуда начинаем (владелец 27.08, PR 4 роадмапа) — НЕЗАВИСИМАЯ от цели
  // сущность: своё состояние, не поле внутри DestinationOption. Смена
  // старта не трогает и не сбрасывает зафиксированную цель (критерий PR 4).
  const [selectedOrigin, setSelectedOrigin] = useState<Origin | null>(null);

  // Автовыбор цели: как только поиск нашёл путь к месту из деплинка.
  useEffect(() => {
    if (!cameFromPlaceRef.current || autoDestConsumedRef.current) return;
    if (searchRoutes.length === 0) return;
    const { destinations } = groupRoutesByDestination(searchRoutes, modalQuery.trim());
    if (destinations.length > 0) {
      autoDestConsumedRef.current = true;
      setSelectedDestination(destinations[0]);
    }
  }, [searchRoutes, modalQuery]);

  // Автовыбор старта: текущая позиция, как только у GPS есть фикс. Второй
  // опрос геолокации не заводим — coords уже идёт с датчика самого экрана.
  useEffect(() => {
    if (!cameFromPlaceRef.current || autoOriginConsumedRef.current || !coords) return;
    autoOriginConsumedRef.current = true;
    setSelectedOrigin({ kind: 'current', lat: coords.lat, lon: coords.lng, accuracyM: coords.accuracy ?? undefined });
  }, [coords]);
  // Клик по карте создаёт coordinate-цель ИЛИ coordinate-старт (владелец
  // 27.08, PR 3+4 роадмапа) — какую из двух, решает режим. Карта появляется,
  // только когда человек сам её открыл.
  const [mapPickMode, setMapPickMode] = useState<'destination' | 'origin' | null>(null);
  /**
   * Правка 30.08 (живая жалоба владельца: «весь путь выбора конечной точки
   * ломаный... как у всех нормальных навигаторов: выбрал место, поставил
   * точку, точка прилипла к карте»).
   *
   * Раньше тап по карте СРАЗУ фиксировал координату и закрывал карту —
   * без единого кадра, где видно, куда именно попал палец. Человек не мог
   * ни проверить точку, ни поправить промах, ни увидеть подтверждение —
   * тап срабатывал как выстрел, не как разговор. Обычные навигаторы (Яндекс,
   * 2ГИС, Google) ведут иначе: тап роняет пину, пина остаётся на карте
   * («прилипает»), и только явное «Поставить точку здесь» фиксирует выбор.
   *
   * pickedCoord — куда упала пина, ДО подтверждения. mapPickCenter/Zoom —
   * стартовый вид мини-карты, вычисляется ОДИН РАЗ при открытии режима (не
   * из живых coords на каждый рендер — так уже дважды ловили ремонт карты
   * на каждый GPS-тик, см. MAP_PICK_DEFAULT_CENTER выше и комментарий у
   * panTo в LeafletMap.tsx).
   */
  const [pickedCoord, setPickedCoord] = useState<{ lat: number; lon: number } | null>(null);
  const [mapPickCenter, setMapPickCenter] = useState<[number, number]>(MAP_PICK_DEFAULT_CENTER);
  const [mapPickZoom, setMapPickZoom] = useState(8);
  // Машина состояний построения пути (владелец 27.08, PR 5A; транспорт —
  // 28.08, PR 5B-1): idle — старт ещё не выбран; building — запрос идёт;
  // done — есть ответ. build() ходит на сервер (httpRouteBuilder), но
  // провайдер за ним не выбран — сегодня ответ всегда unsupported, честно
  // сформированный сервером, не локальной заглушкой.
  const [buildPhase, setBuildPhase] = useState<
    { phase: 'idle' } | { phase: 'building' } | { phase: 'done'; result: RouteBuildResult }
  >({ phase: 'idle' });
  // Повторный запрос без смены origin/destination — например, кнопка
  // «Повторить» после failed. Смена этого числа перезапускает эффект ниже.
  const [buildRetryTick, setBuildRetryTick] = useState(0);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<{
    id: string; title: string; wps: SavedWaypoint[]; grade: PassportGrade | null;
    /** Черта: можно ли обещать ведение. Считается на сервере — см. openPreview. */
    navigability: PreviewNavigability | null;
  } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  /** Отказ по конкретному варианту: показывается у его строки, а не вместо списка. */
  const [previewError, setPreviewError] = useState<{ id: string; text: string } | null>(null);
  /**
   * Предпросмотр РАССЧИТАННОГО автопути — намеренно ОТДЕЛЬНОЕ состояние от
   * `preview` выше (владелец 28.08, план рендеринга calculated_car). `preview`
   * собирается из waypoints каталожного маршрута (`wps`) и открывается через
   * запрос к /api/routes/[id]; у calculated_car нет ни каталожной записи, ни
   * набора точек — вся геометрия уже лежит в RouteOption.calculated. Смешать
   * их в одном состоянии значило бы либо собирать линию из wps (запрещено
   * планом), либо посылать синтетический id на сервер.
   */
  const [calculatedPreview, setCalculatedPreview] = useState<{
    title: string; route: CalculatedCarRoute;
  } | null>(null);
  /** Ошибка геометрии рассчитанного пути — провайдер вернул непригодный GeoJSON. */
  const [calculatedPreviewError, setCalculatedPreviewError] = useState<string | null>(null);
  /**
   * Способ передвижения для ПОСТРОЕНИЯ ПУТИ Origin → Destination (владелец
   * 28.08) — НЕ то же самое, что `travelMode` выше (тот выбирает пеший/
   * авто темп для уже идущей навигации по активному маршруту). Сервер 5B-1
   * подключает провайдера ТОЛЬКО для mode: 'car' — режим 'foot' остаётся
   * честным unsupported до PR 5B-2. Дефолт 'foot' сохраняет прежнее
   * поведение экрана для тех, кто ещё не тронул переключатель.
   */
  const [buildTravelMode, setBuildTravelMode] = useState<RouteBuildMode>('foot');
  const modalSearchRef = useRef<ReturnType<typeof setTimeout>>();
  const previewCacheRef = useRef<Map<string, {
    wps: SavedWaypoint[]; grade: PassportGrade | null; navigability: PreviewNavigability | null;
  }>>(new Map());
  const [tileDl, setTileDl] = useState<{ done: number; total: number } | null>(null);
  /** Массовая закачка карты отключена (M0, владелец 28.08) — причина словами. */
  const [saveMapError, setSaveMapError] = useState<string | null>(null);
  /** План скачивания: сколько это будет весить, пока не скачано. */
  const [mapPlan, setMapPlan] = useState<{
    tiles: number; mb: number; zooms: number[]; dropped: number[];
    coverage: 'corridor' | 'bbox'; bufferKm: number | null; urls: string[];
  } | null>(null);
  /** Заявление о том, что уже лежит в телефоне. */
  const [savedMap, setSavedMap] = useState<SavedMapRecord | null>(null);
  const [dropping, setDropping] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  /**
   * Состояние полевого пакета по ассетам (карта/линия/точки/условия) —
   * проверкой, не памятью: verifyFieldPack пробует Cache Storage и меряет
   * возраст снимка условий. null — пакета нет.
   */
  const [packStates, setPackStates] = useState<PackAssetState[] | null>(null);
  /** Сам манифест пакета — для листа «Условия» (снимок работает без сети). */
  const [pack, setPack] = useState<FieldPackManifest | null>(null);
  /** Редакция маршрута из паспорта — пакет привязывается к ней. */
  const [routeVersion, setRouteVersion] = useState<number | null>(null);
  /** Лист «Условия»: снимок из пакета + живой статус при связи. */
  const [showConditions, setShowConditions] = useState(false);
  const [liveSafety, setLiveSafety] = useState<PackSafetySnapshot | null>(null);
  /** Лист «Группа»: состояние брифинга и экстренная связь. */
  const [showGroup, setShowGroup] = useState(false);
  /**
   * «Продолжить намеренно»: карточка восстановления сворачивается до строки.
   * Ключ — род состояния, а не флаг: новое состояние (ушли с линии после
   * того, как приглушили «карта не сохранена») обязано показаться заново.
   */
  const [mutedRecovery, setMutedRecovery] = useState<string | null>(null);
  /** Свой след: крошки, по которым возвращаются, когда отказало остальное. */
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const crumbsRef = useRef<Crumb[]>([]);
  const crumbsRouteRef = useRef<string | null>(null);
  // Судьба Service Worker: без него офлайн-контура нет, и полевой экран
  // обязан сказать это до выхода, а не оставить человека гадать в поле,
  // почему «сохранённая» карта не открылась.
  const swReg = useSwRegistration();

  /**
   * План скачивания карты — сколько это будет весить.
   *
   * Раньше тайлы качались молча в фоне при первом открытии маршрута. Замысел
   * добрый, исполнение нет: человек не знал ни что качается, ни сколько это
   * весит, ни скачалось ли вообще, — а мобильный трафик тратился без спроса.
   * Проверить готовность было нечем, и единственный момент, когда это можно
   * проверить, наступал уже без связи.
   *
   * Теперь связь тратится по нажатию, а до нажатия виден вес.
   */
  const loadMapPlan = useCallback(async (routeId: string) => {
    try {
      const raw = localStorage.getItem(savedMapKey(routeId));
      setSavedMap(parseSavedMap(raw));
    } catch { /* хранилище может быть закрыто — не повод падать */ }
    if (typeof navigator === 'undefined' || navigator.onLine === false) return;
    try {
      const res = await fetch(`/api/routes/${routeId}/offline-bundle`);
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.tile_urls) || data.tile_urls.length === 0) return;
      setMapPlan({
        tiles: Number(data.tile_count) || data.tile_urls.length,
        mb: Number(data.estimate_mb) || 0,
        zooms: Array.isArray(data.zoom_levels) ? data.zoom_levels : [],
        dropped: Array.isArray(data.dropped_zooms) ? data.dropped_zooms : [],
        coverage: data.tile_coverage === 'bbox' ? 'bbox' : 'corridor',
        bufferKm: typeof data.corridor_buffer_km === 'number' ? data.corridor_buffer_km : null,
        urls: data.tile_urls as string[],
      });
    } catch { /* тихо: план — удобство, а не условие выхода */ }
  }, []);

  /**
   * Собрать манифест полевого пакета: линия + точки + снимок условий +
   * запись о карте — одной записью в IndexedDB. Снимок условий кладётся
   * при сборке: в поле связи не будет, а его возраст обязан быть виден.
   */
  const assemblePack = useCallback(async (routeId: string, failedTiles: number, persisted: boolean) => {
    let safety: PackSafetySnapshot | null = null;
    try {
      const res = await fetch('/api/public/safety-status');
      const j = await res.json() as { success?: boolean; data?: Record<string, unknown> };
      const d = j?.data;
      if (j?.success && d) {
        safety = {
          hasAlert: d.hasAlert === true,
          maxSeverity: Number(d.maxSeverity) || 0,
          topTitle: typeof d.topTitle === 'string' ? d.topTitle : null,
          source: typeof d.source === 'string' ? d.source : '',
          at: Date.now(),
          unavailable: d.unavailable === true,
        };
      }
    } catch { safety = null; }
    const now = Date.now();
    const manifest: FieldPackManifest = {
      routeId,
      routeVersion: routeVersion ?? 1,
      title: activeRouteTitle,
      createdAt: now,
      updatedAt: now,
      route: { track, trackDm, geometrySource: geometrySource ?? null },
      waypoints,
      tiles: mapPlan ? {
        total: mapPlan.tiles, failed: failedTiles, droppedZooms: mapPlan.dropped,
        coverage: mapPlan.coverage, bufferKm: mapPlan.bufferKm, mb: mapPlan.mb,
        sampleUrls: [
          mapPlan.urls[0],
          mapPlan.urls[Math.floor(mapPlan.urls.length / 2)],
          mapPlan.urls[mapPlan.urls.length - 1],
        ].filter(Boolean),
      } : null,
      safety,
      storage: { persistent: persisted },
    };
    try { await saveFieldPack(manifest); } catch { /* квота/приватный режим — покажет verify */ }
    setPack(manifest);
    try { setPackStates(await verifyFieldPack(manifest)); } catch { /* ignore */ }
  }, [mapPlan, track, trackDm, geometrySource, waypoints, activeRouteTitle, routeVersion]);

  /** Поднять и перепроверить сохранённый пакет маршрута. */
  const refreshPackStates = useCallback((routeId: string) => {
    loadFieldPack(routeId)
      .then(async p => {
        setPack(p);
        setPackStates(p ? await verifyFieldPack(p) : null);
      })
      .catch(() => { setPack(null); setPackStates(null); });
  }, []);

  /** Открыть «Условия»: снимок из пакета сразу, живой статус — если есть связь. */
  const openConditions = useCallback(() => {
    setShowConditions(true);
    fetch('/api/public/safety-status')
      .then(r => r.json())
      .then((j: unknown) => {
        const d = (j as { success?: boolean; data?: Record<string, unknown> } | null)?.data;
        if (!(j as { success?: boolean } | null)?.success || !d) return;
        // Недоступность источника — не «спокойно»: живым снимком не считается.
        if (d.unavailable === true) return;
        setLiveSafety({
          hasAlert: d.hasAlert === true,
          maxSeverity: Number(d.maxSeverity) || 0,
          topTitle: typeof d.topTitle === 'string' ? d.topTitle : null,
          source: typeof d.source === 'string' ? d.source : '',
          at: Date.now(),
          unavailable: false,
        });
      })
      .catch(() => { /* офлайн — остаёмся на снимке пакета */ });
  }, []);

  /** Скачать полевой пакет маршрута по явному нажатию (карта — самый тяжёлый ассет). */
  /**
   * Убрать полевой пакет вместе с его картой.
   *
   * `removeFieldPack` считает, какие тайлы не держит больше никто, и отдаёт
   * их service worker'у. Возврат `null` означает «тайлы снять не удалось» —
   * запись пакета при этом всё равно снимается, но выдавать это за
   * освобождённое место нельзя.
   */
  const dropPack = useCallback(async (routeId: string) => {
    setDropping(true);
    try {
      const released = await removeFieldPack(routeId);
      setSavedMap(null);
      setPackStates(null);
      // Отдельная строка, а не общий статус экрана: «пакет убран» и «место
      // не освободилось» — разные сообщения, и второе нельзя проглотить.
      setDropNote(released === null ? 'Пакет убран, но карту из хранилища снять не удалось' : null);
    } finally {
      setDropping(false);
    }
  }, []);

  const saveMap = useCallback(async (routeId: string) => {
    if (!mapPlan || !navigator.serviceWorker) return;
    // Закрепление просим ЖЕСТОМ: без него система вправе вычистить кэш при
    // нехватке места — без предупреждения и, по закону подлости, перед
    // выходом. Отказ браузера не скрываем, он попадёт в запись.
    const persisted = await requestPersistentStorage();
    try {
      const reg = await navigator.serviceWorker.ready;
      const sw = reg.active;
      if (!sw) return;
      setSaveMapError(null);
      setTileDl({ done: 0, total: mapPlan.tiles });
      const onMsg = (e: MessageEvent) => {
        if ((e.data as { regionId?: string })?.regionId !== routeId) return;
        const m = e.data as { type: string; done: number; failed?: number; total: number; reason?: string };
        if (m.type === 'TILE_PROGRESS') setTileDl({ done: m.done, total: m.total });
        // Массовая закачка отключена (M0, владелец 28.08): SW отвечает этим
        // ВМЕСТО TILES_DONE — честно, без попытки скачать хоть один тайл.
        if (m.type === 'TILES_UNAVAILABLE') {
          setTileDl(null);
          setSaveMapError(m.reason || 'Скачивание карты для офлайна временно недоступно');
          navigator.serviceWorker.removeEventListener('message', onMsg);
        }
        if (m.type === 'TILES_DONE') {
          setTileDl(null);
          const rec: SavedMapRecord = {
            at: Date.now(), tiles: mapPlan.tiles, mb: mapPlan.mb,
            zooms: mapPlan.zooms, droppedZooms: mapPlan.dropped,
            coverage: mapPlan.coverage, bufferKm: mapPlan.bufferKm, persisted,
          };
          setSavedMap(rec);
          try { localStorage.setItem(savedMapKey(routeId), JSON.stringify(rec)); } catch { /* ignore */ }
          navigator.serviceWorker.removeEventListener('message', onMsg);
          // Пакет собирается той же кнопкой: карта, линия, точки и снимок
          // условий — один шаг, а не три разных «сохранить».
          void assemblePack(routeId, m.failed ?? 0, persisted);
        }
      };
      navigator.serviceWorker.addEventListener('message', onMsg);
      sw.postMessage({ type: 'CACHE_TILES', tiles: mapPlan.urls, regionId: routeId });
    } catch { /* ignore */ }
  }, [mapPlan, assemblePack]);

  // Shared route loader. Точки маршрута нужны в поле без связи, поэтому:
  // сперва поднимаем из localStorage-кэша (офлайн-стойко), затем обновляем из
  // API если есть сеть и перекладываем в кэш на будущее.
  const fetchRouteWaypoints = useCallback((routeId: string) => {
    // Ключ кэша ВЕРСИОНИРОВАН. Записи прежнего ключа сняты по старым
    // правилам — до того, как «рядом» перестало быть точкой пути (§4.1,
    // миграция 874). Новая сборка честно фильтрует их при записи, но при
    // открытии экрана читает кэш ПЕРВЫМ (чтобы работать офлайн) — и рисует
    // чужие точки, пока не придёт ответ сети. На телефоне владельца 21.08
    // это была ломаная через полуостров у маршрута длиной полтора километра.
    // Смена ключа — честный сброс: старое знание построено по правилам,
    // которых больше нет.
    const cacheKey = `trail_route_wps_v2_${routeId}`;
    try { localStorage.removeItem(`trail_route_wps_${routeId}`); } catch { /* приватный режим */ }

    // 1. Мгновенно из кэша — работает офлайн
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { title: string | null; waypoints: SavedWaypoint[] };
        if (Array.isArray(parsed.waypoints) && parsed.waypoints.length > 0) {
          setWaypoints(parsed.waypoints);
          setActiveRouteTitle(parsed.title);
        }
      }
    } catch { /* битый кэш — игнорируем */ }

    // 2. Обновляем из сети (если есть) и кэшируем
    setIsLoadingRoute(true);
    fetch(`/api/routes/${routeId}`)
      .then(r => r.json())
      .then((j: unknown) => {
        if (typeof j !== 'object' || j === null || !(j as Record<string, unknown>).success) return;
        const data = (j as Record<string, unknown>).data as Record<string, unknown>;
        setActiveRouteTitle(data.title as string);
        // Рельеф приходит готовым; форму проверяем защитно — молчаливо
        // «нет данных» лучше, чем график из мусора.
        const rel = data.relief as {
          reliable?: unknown; ascentM?: unknown; descentM?: unknown; points?: unknown;
          elevationSource?: unknown;
        } | null | undefined;
        setRelief(rel && Array.isArray(rel.points) && rel.reliable === true
          ? {
              reliable: true,
              source: typeof rel.elevationSource === 'string' ? rel.elevationSource : null,
              ascentM: Number(rel.ascentM) || 0,
              descentM: Number(rel.descentM) || 0,
              points: (rel.points as Array<{ dM: number; zM: number }>).filter(
                p => Number.isFinite(p?.dM) && Number.isFinite(p?.zM),
              ),
            }
          : null);
        const tr = data.track;
        setTrack(Array.isArray(tr) && tr.length >= 2 ? (tr as Array<[number, number]>) : null);
        // Источник и трек ставятся из одного ответа — они описывают одну
        // и ту же линию. Строка → источник записан, иначе — честный null.
        setGeometrySource(typeof data.geometrySource === 'string' ? data.geometrySource : null);
        // Редакция маршрута из паспорта: полевой пакет привязывается к ней.
        const pp = data.passport as { version?: unknown } | null | undefined;
        setRouteVersion(typeof pp?.version === 'number' ? pp.version : null);
        const dm = (data as Record<string, unknown>).track_dm;
        setTrackDm(Array.isArray(dm) && Array.isArray(tr) && dm.length === tr.length
          ? (dm as number[])
          // Длины не совпали — шкале верить нельзя, и подставлять
          // «почти подходящую» нельзя тем более.
          : null);
        // Отметка свежести ставится по факту успешного ответа, а не по
        // открытию экрана: иначе «снимок от 14:32» означал бы «я посмотрел в
        // 14:32», а не «данные такие на 14:32».
        setLiveDataAt(Date.now());
        const wps = data.waypoints;
        const converted: SavedWaypoint[] = (Array.isArray(wps) ? wps as Array<Record<string, unknown>> : [])
          .filter(w => w.lat != null && w.lng != null)
          // «Рядом» — не точка пути (§4.1, миграция 874): у Скал Три Брата
          // краевой музей и батарея Максутова числились этапами, и полевой
          // ход честно считал по ним 142 км ломаной на прогулку в пару
          // километров (поле, 20.08). Карточка маршрута эти связи уже
          // отделяет; полевой контур им не ведёт вовсе. unknown участвует,
          // как раньше, — незнание рода не лишает точку пути.
          .filter(w => w.linkKind !== 'nearby')
          .map(w => ({
            lat: Number(w.lat),
            lng: Number(w.lng),
            name: (w.placeName as string | null) ?? `Точка ${Number(w.position) + 1}`,
          }));
        // Ноль путевых точек — ЗАКОННЫЙ результат, а не отказ: у Скал Три
        // Брата все 23 связи стали «рядом», путь описан одним треком. Прежний
        // код обновлял стейт и кэш только при непустом списке — телефон,
        // однажды скачавший 23 «этапа», жил на них вечно: полевой скрин 21.08
        // показывал 142.3 км через сутки после починки данных. Пустота обязана
        // перезаписывать кэш так же, как непустота.
        //
        // Ход при этом не теряется: точками становятся начало и конец снятой
        // линии — честные имена, ведение вдоль трека, дистанция по треку.
        const effective: SavedWaypoint[] = converted.length > 0
          ? converted
          : Array.isArray(tr) && tr.length >= 2
            ? [
                { lat: (tr as [number, number][])[0][0], lng: (tr as [number, number][])[0][1], name: 'Начало трека' },
                { lat: (tr as [number, number][])[tr.length - 1][0], lng: (tr as [number, number][])[tr.length - 1][1], name: 'Конец трека' },
              ]
            : [];
        setWaypoints(effective);
        try { localStorage.setItem(cacheKey, JSON.stringify({ title: data.title as string, waypoints: effective })); } catch { /* квота */ }
        if (effective.length > 0) {
          void loadMapPlan(routeId); // что уже скачано и сколько весит недостающее
        }
      })
      .catch(() => {
        // Офлайн — точки уже показаны из кэша. Линию поднимаем из полевого
        // пакета: без него поле без сети оставалось вовсе без трека, и
        // экран честно деградировал до наброска, теряя снятую линию,
        // которую человек видел при сохранении пакета.
        void loadFieldPack(routeId).then(pack => {
          if (!pack || !pack.route.track || pack.route.track.length < 2) return;
          setTrack(pack.route.track);
          setTrackDm(pack.route.trackDm);
          setGeometrySource(pack.route.geometrySource);
          setRouteVersion(pack.routeVersion);
        }).catch(() => { /* пакета нет — остаёмся на кэше точек */ });
      })
      .finally(() => setIsLoadingRoute(false));
    // Состояние пакета — сразу из записи (и перепроверкой), не дожидаясь сети.
    refreshPackStates(routeId);
  }, [loadMapPlan, refreshPackStates]);

  // Network
  useEffect(() => {
    setIsOffline(!navigator.onLine);
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  // Load active route on mount
  useEffect(() => {
    const routeId = localStorage.getItem('active_trail_route_id');
    if (!routeId) return;
    // Свой след поднимаем ДО первого фикса: он про уже пройденное, и ждать
    // спутников, чтобы показать вчерашний путь, незачем.
    crumbsRouteRef.current = routeId;
    try {
      const raw = localStorage.getItem(crumbsKey(routeId));
      const restored = parseCrumbs(raw);
      crumbsRef.current = restored;
      setCrumbs(restored);
      // parseCrumbs теперь отсеивает недостоверные точки (правка 30.08,
      // «трек за пределы Камчатки») — если брак был в самом хранилище
      // (скрин владельца: след до Магаданской области), переписываем диск
      // очищенной версией сразу, не дожидаясь следующей крошки: иначе брак
      // переживёт этот визит и всплывёт снова при следующем открытии.
      const cleanedSerialized = serializeCrumbs(restored);
      if (raw !== null && raw !== cleanedSerialized) {
        localStorage.setItem(crumbsKey(routeId), cleanedSerialized);
      }
    } catch { /* хранилище закрыто — начнём след заново */ }
    fetchRouteWaypoints(routeId);
  }, [fetchRouteWaypoints]);

  // На iOS 13+ события ориентации не приходят, пока пользователь не разрешит
  // их ЖЕСТОМ. Без этого heading навсегда оставался нулём, а стрелка —
  // уверенно «на север» (аудит 09.08). Теперь это видно и починяемо кнопкой.
  useEffect(() => {
    if (compassNeedsPermission()) setCompassState('blocked');
  }, []);
  const enableCompass = useCallback(async () => {
    const ctor = (window as unknown as {
      DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
    }).DeviceOrientationEvent;
    try {
      const res = await ctor?.requestPermission?.();
      setCompassState(res === 'granted' ? 'unconfirmed' : 'off');
    } catch {
      setCompassState('off');
    }
  }, []);

  // Режим движения переживает перезапуск: в поле переключать его каждый раз —
  // лишний повод получить враньё во времени.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('on_route_travel_mode');
      if (saved === 'car' || saved === 'foot') setTravelMode(saved);
    } catch { /* приватный режим */ }
  }, []);
  const changeTravelMode = useCallback((m: TravelMode) => {
    setTravelMode(m);
    try { localStorage.setItem('on_route_travel_mode', m); } catch { /* приватный режим */ }
  }, []);

  // PWA днями живёт в фоне без перемонтирования: возврат на экран — рефетч
  // точек активного маршрута. Скрин владельца 2026-07-19: API уже отдавал
  // починенную координату, а приложение держало вчерашний state в памяти
  // (точка «в 285 км» при честных 13) — mount-рефетча для поля недостаточно.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const routeId = localStorage.getItem('active_trail_route_id');
      if (routeId) fetchRouteWaypoints(routeId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchRouteWaypoints]);

  // Wake Lock
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    if ('wakeLock' in navigator) {
      (navigator.wakeLock as WakeLock).request('screen').then(wl => { wakeLock = wl; }).catch(() => {});
    }
    return () => { wakeLock?.release().catch(() => {}); };
  }, []);

  // Прогрев куска карты убран сразу после ввода (09.08). Замысел был верный —
  // грузить, пока человек смотрит на компас, — но неудачная попытка отравляет
  // модуль: сборщик запоминает отвергнутое обещание, и нажатие на кнопку потом
  // не грузит ничего. На маршруте связь рвётся именно так, и цена промаха —
  // чёрный экран вместо карты. Ускорение не стоит такого риска; вместо него
  // карта теперь честно говорит о неудаче и предлагает повторить.

  // Sensors + timer — run once on mount; timer reads startTimeRef at call time
  useEffect(() => {
    // Азимут берём только там, где он привязан к земной системе координат:
    // webkitCompassHeading на iOS, событие deviceorientationabsolute или
    // alpha с флагом absolute. Без этого alpha отсчитывается от случайной
    // начальной ориентации телефона — выдавать её за север нельзя.
    //
    // Источника два, и они соперничают. На Android Chrome приходят ОБА
    // события, причём относительное — тоже постоянно. Пока оба шли в один
    // обработчик, относительное затирало честный азимут через такт, и
    // предупреждение «компас не подтверждён» висело вечно на исправном
    // магнитометре (владелец 09.08: «что за баг?»). Поэтому земной источник
    // выигрывает навсегда: увидели его хоть раз — относительное больше не
    // слушаем.
    const handleAbsolute = (e: DeviceOrientationEvent) => {
      const r = readHeading(e as DeviceOrientationEvent & { webkitCompassHeading?: number }, true);
      if (!r) return;
      sawAbsoluteRef.current = true;
      setHeading(r.heading);
      setCompassState(r.state);
    };
    const handleRelative = (e: DeviceOrientationEvent) => {
      if (sawAbsoluteRef.current) return;
      const r = readHeading(e as DeviceOrientationEvent & { webkitCompassHeading?: number });
      if (!r) return;
      setHeading(r.heading);
      setCompassState(r.state);
    };
    window.addEventListener('deviceorientationabsolute', handleAbsolute as EventListener, true);
    window.addEventListener('deviceorientation', handleRelative as EventListener);
    if ('geolocation' in navigator) {
      watchRef.current = navigator.geolocation.watchPosition(
        pos => {
          // Свежий timestamp с точностью в десятки километров — не GPS, а
          // сетевой/IP-фолбэк геолокации браузера (живой скрин владельца
          // 29.08: ±64642 м → «7921 км до точки»). Отбрасываем ТУТ, у
          // источника: если принять его в coords, та же ложь разъедется по
          // approach/distToNext/RecoveryCard/точке на карте — точечные
          // проверки на каждом месте потребления гонялись бы за одной и той
          // же причиной по всему экрану. Не обновляя coords, ничего не
          // портим: пробел просто состарит текущий фикс честно, тем же
          // fixInfo, что уже отличает stale/dead от live.
          if (typeof pos.coords.accuracy === 'number' && !fixAccuracyPlausible(pos.coords.accuracy)) {
            return;
          }
          setGpsMessage(null);
          setCoords({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            alt: pos.coords.altitude,
            accuracy: typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : null,
            t: pos.timestamp ?? Date.now(),
          });
          // Курс по движению — только на ходу (от 1 м/с) и только конечный:
          // стоя GPS отдаёт мусорный heading, и выдавать его за курс нельзя.
          const spd = pos.coords.speed;
          const crs = pos.coords.heading;
          if (typeof spd === 'number' && spd >= 1 &&
              typeof crs === 'number' && Number.isFinite(crs)) {
            setGpsCourse({ heading: crs, t: pos.timestamp ?? Date.now() });
          }
          // След последнего получаса — из него считается живой темп. Держим
          // в ref: он не должен вызывать перерисовку на каждом GPS-тике.
          const t = Date.now();
          const track = trackRef.current;
          track.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, t });
          const cutoff = t - 30 * 60 * 1000;
          while (track.length > 0 && track[0].t < cutoff) track.shift();

          // Крошки на диск: свой след — единственный способ вернуться, когда
          // отказало остальное. Прежний след жил в памяти полчаса и умирал
          // при перезагрузке, а телефон на морозе перезагружается сам.
          //
          // Пишем по пройденному расстоянию, а не по времени: час у ручья не
          // должен съесть квоту хранилища. Совпадение ссылок означает «точка
          // не добавила знания» — тогда и на диск ходить незачем.
          const routeForCrumbs = crumbsRouteRef.current;
          if (routeForCrumbs) {
            const before = crumbsRef.current;
            const after = addCrumb(before, { lat: pos.coords.latitude, lng: pos.coords.longitude, t });
            if (after !== before) {
              crumbsRef.current = after;
              setCrumbs(after);
              try { localStorage.setItem(crumbsKey(routeForCrumbs), serializeCrumbs(after)); }
              catch { /* квота кончилась — след в памяти всё равно жив */ }
            }
          }
        },
        err => {
          // Раньше замечали только отказ в доступе (код 1), а «позиция
          // недоступна» и таймаут проходили молча — экран продолжал уверенно
          // показывать последние координаты.
          if (err.code === 1) setGpsError(true);
          else setGpsMessage(err.code === 3 ? 'GPS не отвечает' : 'GPS недоступен здесь');
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 30_000 }
      );
    }
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    // Темп — раз в полминуты по следу: чаще незачем, а дёргать экран вредно.
    const paceTimer = setInterval(() => {
      setPaceKmh(paceFromTrack(trackRef.current, 900));
    }, 30_000);
    // Возраст последнего фикса стареет сам по себе — иначе «сигнал потерян»
    // не появится никогда: мёртвый GPS событий не шлёт.
    const ageTimer = setInterval(() => setNowTick(Date.now()), 5_000);
    return () => {
      window.removeEventListener('deviceorientationabsolute', handleAbsolute as EventListener, true);
      window.removeEventListener('deviceorientation', handleRelative as EventListener);
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      clearInterval(timer);
      clearInterval(paceTimer);
      clearInterval(ageTimer);
    };
  }, []); // startTimeRef is a ref — read at callback time, no restart needed

  /**
   * Старт с ближайшей точки — но только если человек УЖЕ на маршруте.
   *
   * Замысел был верный: тот, кто стоит посреди тропы, не должен получать «до
   * точки 1 — сорок километров назад». Условия у правила не было, и оно
   * срабатывало всегда.
   *
   * Полевой скрин 17.08, «Вулкан Козельский»: человек в городе, ближайшей из
   * трёх точек случайно оказалась последняя — экран написал «3 из 3». Прибор
   * объявил маршрут почти пройденным, когда к нему ещё не подошли: прогресс
   * полный, точек впереди нет, а идти — всё.
   *
   * Дальше ON_ROUTE_ENTRY_KM маршрут начинается с начала, а дорога от человека
   * до первой точки показывается подходом — тем, чем она и является.
   */
  const snappedRef = useRef(false);
  useEffect(() => {
    if (snappedRef.current || !coords || waypoints.length === 0) return;
    let best = 0, bestD = Infinity;
    waypoints.forEach((w, i) => {
      const d = haversine(coords.lat, coords.lng, w.lat, w.lng);
      if (d < bestD) { bestD = d; best = i; }
    });
    setCurrentWpIdx(bestD <= ON_ROUTE_ENTRY_KM ? best : 0);
    snappedRef.current = true;
  }, [coords, waypoints]);

  // Переход на следующую точку двигает весь маршрут, поэтому решается только
  // по фиксу, которому можно верить: при точности 300 м человек может стоять
  // в трёхстах метрах от точки, и «мы дошли» уведёт его от цели (аудит 09.08).
  useEffect(() => {
    if (!coords || waypoints.length === 0) return;
    const wp = waypoints[currentWpIdx];
    if (!wp) return;
    const dist = haversine(coords.lat, coords.lng, wp.lat, wp.lng);
    const info = fixInfo(coords.t, coords.accuracy, Date.now());
    if (canAdvanceWaypoint(info, dist) && currentWpIdx < waypoints.length - 1) {
      setCurrentWpIdx(i => i + 1);
    }
  }, [coords, waypoints, currentWpIdx]);

  // ─── Computed ──────────────────────────────────────────────────────────────

  // Что прибор знает прямо сейчас: свежесть и точность последнего фикса.
  const fix = useMemo(
    () => fixInfo(coords?.t ?? null, coords?.accuracy ?? null, nowTick),
    [coords, nowTick],
  );
  const figuresLive = figuresAreLive(fix);

  /**
   * Состояние экрана. Раньше он всегда показывал полную приборную панель: без
   * маршрута и без GPS сверху вставало четыре полосы (сеть, GPS, компас,
   * разрешение — две из них про одно и то же), под ними мёртвый компас и
   * карточки «— м» и «0ч 00м». Это отчёт системы о себе, а не подсказка, что
   * делать (владелец 09.08: «неверный empty state»). Теперь экран показывает
   * ровно то, что соответствует моменту.
   */
  const hasRoute = waypoints.length > 0 || Boolean(activeRouteTitle);

  /** Одна строка — самое важное действие сейчас. Всё хорошо — строки нет. */
  const status = useMemo((): { tone: 'warn' | 'info'; text: string; cta?: 'compass' } | null => {
    if (gpsError) return { tone: 'warn', text: 'Геолокация запрещена — включите её в настройках браузера' };
    if (fix.state === 'none') return { tone: 'info', text: 'Ищем спутники…' };
    if (gpsMessage) return { tone: 'warn', text: gpsMessage };
    if (fix.state === 'dead' || fix.state === 'stale') return { tone: 'warn', text: fixLabel(fix) };
    // Ступень связи, а не только режим. Прежняя строка сообщала «офлайн» и
    // безусловно обещала, что карты и точки доступны, — хотя карта лежит в
    // телефоне, только если её скачали, а снимок трёхдневной давности
    // выглядел так же, как живые данные.
    if (isOffline) {
      const c = connectivityState({
        online: false,
        packageAt: savedMap?.at ?? null,
        liveAt: liveDataAt,
        now: Date.now(),
      });
      return {
        tone: c.tone === 'alarm' ? 'warn' : 'info',
        text: c.detail ? `${c.title}. ${c.detail}` : c.title,
      };
    }
    if (compassState === 'blocked') return { tone: 'info', text: 'Компас выключен', cta: 'compass' };
    if (compassState === 'unconfirmed') return { tone: 'warn', text: 'Компас не подтверждён — сверяйтесь с картой' };
    return null;
  }, [gpsError, fix, gpsMessage, isOffline, compassState]);

  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const altitude = coords?.alt != null ? Math.round(coords.alt) : null;
  const nextWp = waypoints[currentWpIdx] ?? null;

  /**
   * Азимут на следующую точку — то, что показывает стрелка прибора.
   * Без своего положения азимута нет: считать его от чего-то другого
   * значило бы показать направление, которого мы не знаем.
   */
  const targetBearing = useMemo(() => {
    if (!coords || !nextWp || !fixUsableForNavigation(coords.accuracy ?? null)) return null;
    return bearingDeg({ lat: coords.lat, lng: coords.lng }, { lat: nextWp.lat, lng: nextWp.lng });
  }, [coords, nextWp]);

  /**
   * Коридор: до двух точек ПОСЛЕ следующей, каждая с длиной своего отрезка
   * по прямой между точками (честная мера — подпись об этом в компоненте).
   * Финиш помечается флагом.
   */
  const corridorItems = useMemo(() => {
    if (waypoints.length < 2) return [];
    return waypoints.slice(currentWpIdx + 1, currentWpIdx + 3).map((w, i) => {
      const prev = waypoints[currentWpIdx + i];
      return {
        name: w.name,
        segmentKm: prev ? haversine(prev.lat, prev.lng, w.lat, w.lng) : null,
        isLast: currentWpIdx + 1 + i === waypoints.length - 1,
      };
    });
  }, [waypoints, currentWpIdx]);

  /**
   * Источник курса для прибора. Подтверждённый магнитометр главнее (работает
   * стоя); без него на ходу курс берётся из движения GPS — с подписью, откуда
   * он взят (родословная значения, тот же закон, что у линий §12). Свежесть
   * судится по nowTick: мёртвый GPS новых курсов не шлёт, и через несколько
   * секунд прибор честно возвращается в «не подтверждён».
   */
  const courseFresh = gpsCourse !== null && nowTick - gpsCourse.t < 8000;
  const headingSource: 'sensor' | 'motion' | null =
    compassState === 'ok' ? 'sensor' : courseFresh ? 'motion' : null;
  const effHeading = headingSource === 'motion' && gpsCourse ? gpsCourse.heading : heading;
  const effCompassState: CompassState = headingSource === 'motion' ? 'ok' : compassState;

  // Маркеры для карты: линия трека + точки маршрута (текущая — оранжевая).
  // useMemo обязателен: LeafletMap пересоздаёт карту при смене identity
  // markers — пересборка на каждом рендере (GPS-тики) убивала карту.
  // Линию рисуем по НАСТОЯЩЕМУ треку, а не по ломаной между точками.
  // Владелец 09.08 открыл карту на «Мысе Маячном» и увидел одинокий маркер:
  // у маршрута одна точка, ломаная из одной вершины — это ничто. Трек при
  // этом был, им же рисуется схема «вид сверху» этажом ниже. Карта навигации
  // без пути хуже отсутствия карты: человек решает, что маршрут не загрузился.
  /**
   * Происхождение линии на карте: снятый трек или ломаная между точками.
   * Род линии спрашивается у ЗАПИСИ (`geometry->>'source'` через trackLine),
   * плотность точек — только когда источник не записан. Перепись 11.08
   * (проба 55): у 295 линий из 301 источник есть, а плотностная эвристика
   * на «Вулкане Жупановском» выдавала синтетику за снятый трек — сплошная
   * зелёная означает «здесь идут», и по ней идут.
   */
  const lineFidelity: TrackFidelity = useMemo(() => {
    const wpLine = waypoints.map(w => [w.lat, w.lng] as [number, number]);
    const fallback = wpLine.length >= 2 && !isScatteredCollection(wpLine) ? wpLine : null;
    const line = track && track.length >= 2 ? track : fallback;
    // Ломаная, собранная нами из путевых точек, — заведомо набросок:
    // считать её плотность незачем, происхождение известно точно.
    if (!track || track.length < 2) return line ? 'sketch' : 'unknown';
    return trackLine(track, geometrySource)?.fidelity ?? 'unknown';
  }, [track, waypoints, geometrySource]);

  /**
   * Путь от МЕСТА ЧЕЛОВЕКА вдоль тропы, а не по прямой через залив.
   *
   * Скриншот владельца 11.08: «до точки 20.3 км по прямой», человек в
   * Петропавловске, цель — в Авачинской бухте, трек уходит на юго-запад.
   * Прямая между ними пересекает залив: число честно буквально и бесполезно
   * по существу, а нарисованной линии не соответствует вовсе.
   */
  // Положение вдоль трека ведётся СОСТОЯНИЕМ, а не ищется заново на каждом
  // фиксе. Глобальный поиск перекидывает проекцию на встречную ветку
  // радиального маршрута, и «осталось 3 км» становится «17 км» у неподвижного
  // человека — прибор, чьи показания скачут втрое на месте, перестают читать.
  const alongRef = useRef<AlongState | null>(null);
  const approach = useMemo(() => {
    if (!coords || !nextWp || !track || track.length < 2) return null;
    const line = track.map(([lat, lng]) => ({ lat, lng }));
    // Плохой фикс не двигает положение: иначе окно проекции прыгало бы на
    // шуме, ради устранения которого оно и заведено. Что показанное при этом
    // не свежее — говорит fixInfo/figuresAreLive, отдельной сущности не надо.
    if (fixUsableForNavigation(coords.accuracy ?? null)) {
      alongRef.current = advanceAlong({ lat: coords.lat, lng: coords.lng }, line, alongRef.current);
    }
    return approachPlan(
      { lat: coords.lat, lng: coords.lng },
      { lat: nextWp.lat, lng: nextWp.lng },
      line,
      alongRef.current?.projection ?? null,
      // Порог отхода — от точности фикса, а не константа: ложное «вы в
      // стороне» гонит человека искать тропу, которой он и так держится.
      offTrackThresholdM(coords.accuracy ?? null) / 1000,
    );
  }, [coords, nextWp, track]);

  // Смена маршрута обнуляет историю положения: она была про другой трек.
  // Трек меняется вместе с маршрутом, поэтому его и достаточно: история
  // положения была про другую ломаную.
  useEffect(() => { alongRef.current = null; }, [track]);

  /**
   * Линия подхода для КАРТЫ — с огрублённым положением.
   *
   * LeafletMap пересоздаёт карту при смене identity массива маркеров, и об
   * этом прямо сказано у соседнего useMemo. Первая редакция подхода положила
   * в зависимости `coords`, который меняется на КАЖДОМ фиксе GPS: карта
   * перестраивалась по нескольку раз в минуту, мигала и сбрасывала зум —
   * владелец увидел это в поле как «карта постоянно перезагружается».
   *
   * Поэтому в зависимостях лежат не координаты, а их огрубление до четвёртого
   * знака (~11 м): человек стоит — identity не меняется вовсе, идёт — линия
   * догоняет шагами по одиннадцать метров, что на масштабе карты незаметно.
   *
   * И линия рисуется только когда человек в стороне от тропы. На тропе ей
   * нечего показывать, а каждая лишняя перерисовка — это мигание в поле.
   */
  const offTrackNow = approach?.userOffTrack === true;
  const coarseLat = coords ? Math.round(coords.lat * 1e4) : null;
  const coarseLng = coords ? Math.round(coords.lng * 1e4) : null;
  const joinLat = approach ? Math.round(approach.joinAt.lat * 1e4) : null;
  const joinLng = approach ? Math.round(approach.joinAt.lng * 1e4) : null;
  const approachLine = useMemo(() => {
    if (!offTrackNow || coarseLat === null || coarseLng === null || joinLat === null || joinLng === null) {
      return null;
    }
    return {
      from: [coarseLat / 1e4, coarseLng / 1e4] as [number, number],
      to: [joinLat / 1e4, joinLng / 1e4] as [number, number],
    };
  }, [offTrackNow, coarseLat, coarseLng, joinLat, joinLng]);

  const mapMarkers: MapMarker[] = useMemo(() => {
    // Линия маршрута — общая функция с backgroundMapMarkers (ниже), не
    // вторая копия той же логики. Комментарий о том, почему линия иногда
    // гасится целиком (dataConflict, регресс 24.08), теперь у самой функции
    // (computeRouteLineMarker) — читать его там, не здесь.
    const routeLine = computeRouteLineMarker(
      track, waypoints, activeRouteTitle, approach?.dataConflict === true, lineFidelity,
    );
    if (!routeLine && waypoints.length === 0) return [];
    return [
      ...(routeLine ? [routeLine] : []),
      // Подход: от человека до тропы. Пунктиром и приглушённо — это НЕ тропа,
      // а прямая по азимуту, и рисовать её тем же уверенным зелёным значило бы
      // обещать путь там, где его никто не снимал.
      ...(approachLine ? [{
        coords: approachLine.from,
        title: CONNECTOR_TITLES.approach,
        geometry: {
          type: 'polyline',
          coordinates: [approachLine.from, approachLine.to] as Array<[number, number]>,
          // Подход — ПОСТРОЕНИЕ по азимуту, не снятый путь. Вид берётся из
          // общего стандарта (lib/map/line-standard), а не собирается тут:
          // ровно так правило и разъезжалось по экранам.
          ...connectorLine(),
        } as MapMarkerGeometry,
        suppressBalloon: true,
      }] : []),
      // Свой след — отдельной линией и другим цветом. Путать его с маршрутом
      // нельзя: маршрут это куда идти, след это где человек был. Возвращаются
      // по второму.
      ...(crumbs.length >= 2 ? [{
        coords: [crumbs[0].lat, crumbs[0].lng] as [number, number],
        title: 'Ваш след',
        geometry: {
          type: 'polyline',
          coordinates: crumbs.map(c => [c.lat, c.lng] as [number, number]),
          color: '#38BDF8', weight: 3,
        } as MapMarkerGeometry,
        suppressBalloon: true,
      }] : []),
      ...waypoints.map((w, i): MapMarker => ({
        coords: [w.lat, w.lng],
        title: w.name,
        color: i === currentWpIdx ? 'orange' : 'green',
        type: MarkerType.POI,
      })),
    ];
  }, [track, waypoints, currentWpIdx, activeRouteTitle, crumbs, approachLine, approach?.dataConflict]);
  /**
   * Постоянная карта-фон (Шаг 1) видна ВСЕГДА, в т.ч. под приборной
   * колонкой, и должна быть спокойным задником, а не живым инструментом.
   * Два самостоятельных живых скрина владельца 29.08 про одну причину:
   *
   *  1. numbered POI-пины путевых точек рассчитаны на полноэкранный режим
   *     «Карта», где им есть куда встать — на фоне они торчали в узких
   *     промежутках между карточками (кружок «3» между геройской карточкой
   *     и панелью действий);
   *  2. карта «постоянно моргает» — фон брал ТУ ЖЕ identity markers, что и
   *     живой mapMarkers (зависит от crumbs/approachLine — обновляются на
   *     каждом шаге человека), и пересоздавался вслед за ней. Раньше это
   *     не было заметно: карта открывалась только по кнопке «Карта», где
   *     живое обновление и есть цель.
   *
   * Фон получает ТОЛЬКО линию маршрута, посчитанную НЕЗАВИСИМО от mapMarkers
   * — своим useMemo с узким набором зависимостей, не включающим coords/
   * crumbs/approachLine/currentWpIdx. Полный живой набор (линия + подход +
   * след + пины) — по-прежнему в mapMarkers, для полноэкранного режима
   * «Карта» (showMap=true), где обновление на ходу — то, зачем экран открыт.
   */
  const backgroundMapMarkers: MapMarker[] = useMemo(() => {
    const routeLine = computeRouteLineMarker(
      track, waypoints, activeRouteTitle, approach?.dataConflict === true, lineFidelity,
    );
    return routeLine ? [routeLine] : [];
  }, [track, waypoints, activeRouteTitle, approach?.dataConflict, lineFidelity]);
  /**
   * Пина на мини-карте пикера точки (правка 30.08, «точка прилипла к
   * карте») — своим useMemo, а не инлайн-массивом в JSX: инлайн-литерал
   * пересоздавал бы identity на КАЖДЫЙ рендер (тот же класс бага, что уже
   * ловили у MAP_PICK_DEFAULT_CENTER), и мини-карта пикера моргала бы, даже
   * не дожидаясь тапа. Меняется только вместе с pickedCoord — то есть один
   * раз на тап, не на каждый чих состояния экрана.
   */
  const pickMarkers: MapMarker[] = useMemo(() => (
    pickedCoord
      ? [{
          coords: [pickedCoord.lat, pickedCoord.lon] as [number, number],
          title: 'Точка',
          color: 'orange',
          type: MarkerType.POI,
          suppressBalloon: true,
        }]
      : []
  ), [pickedCoord]);
  /**
   * Та же пина — на карточке уже ЗАФИКСИРОВАННОЙ координатной цели
   * (правка 30.08). Без неё после подтверждения человек видел только два
   * числа (широта/долгота), а «прилипла к карте» — про то, что точку
   * видно, а не про то, что она посчитана. identity держится на
   * selectedDestination целиком: он новый объект только при СМЕНЕ выбора,
   * не на каждый рендер экрана.
   */
  const destinationPinMap = useMemo(() => {
    if (!selectedDestination || selectedDestination.destination.kind !== 'coordinate') return null;
    const { lat, lon } = selectedDestination.destination;
    return {
      center: [lat, lon] as [number, number],
      markers: [{
        coords: [lat, lon] as [number, number],
        title: 'Точка',
        color: 'orange',
        type: MarkerType.POI,
        suppressBalloon: true,
      }] as MapMarker[],
    };
  }, [selectedDestination]);
  // Карта превью варианта: identity стабильна на выбранный вариант —
  // LeafletMap пересоздаётся только при смене превью, не на каждом рендере
  const previewMap = useMemo(() => {
    if (!preview || preview.wps.length === 0) return null;
    const center: [number, number] = [preview.wps[0].lat, preview.wps[0].lng];
    const line = preview.wps.map(w => [w.lat, w.lng] as [number, number]);
    // Сборник мест по всему краю (сегменты >25 км) — не трек: линию не
    // рисуем и «Начать по маршруту» не предлагаем
    const scattered = isScatteredCollection(line);
    // Одна точка — это место, а не путь: идти «из точки в неё же» нельзя,
    // и предлагать старт по такой записи — обещание маршрута, которого нет
    // (проверка 16.08: «Восхождение на Авачинский вулкан», одна точка,
    // подписано «14 км»). Причина отказа отдельная от scattered: там путь
    // есть, но он не единый; здесь пути нет вовсе.
    const singlePoint = preview.wps.length < 2;
    // Источник известен без API: линия только что построена прямыми между
    // путевыми точками. Синтетика по построению — набросок при любой
    // плотности, сколько бы точек в маршруте ни было.
    const previewLine = trackLine(line, 'waypoints_synthetic');
    const markers: MapMarker[] = [
      ...(scattered || singlePoint ? [] : [{
        coords: center,
        title: preview.title,
        color: 'teal',
        type: MarkerType.POI,
        // Превью строится по ПУТЕВЫМ ТОЧКАМ, а не по снятому треку: это
        // ломаная между местами, и сплошная зелёная в четыре пикселя обещала
        // здесь тропу, которой никто не снимал. Вид — из общего стандарта.
        geometry: { type: 'polyline', coordinates: line, ...(previewLine?.style ?? connectorLine()) } as MapMarkerGeometry,
      }]),
      ...preview.wps.map((w, i) => ({
        coords: [w.lat, w.lng] as [number, number],
        title: w.name,
        color: i === 0 ? 'orange' : 'green',
        type: MarkerType.POI,
      })),
    ];
    return { center, markers, scattered, singlePoint };
  }, [preview]);

  /**
   * Карта предпросмотра РАССЧИТАННОГО автопути (владелец 28.08). Линия
   * строится ИСКЛЮЧИТЕЛЬНО через calculatedCarLine() + явный конвертер
   * координат — план запрещает собирать её из wps или звать trackLine():
   * это не снятый трек и не набросок по путевым точкам, а результат расчёта
   * маршрутизатора для конкретной пары «откуда → куда».
   *
   * `null` конвертера — провайдер вернул непригодную геометрию: карта не
   * строится вовсе, вызывающий код показывает честное сообщение отдельно
   * (см. openPreview) вместо того, чтобы угадывать форму линии.
   */
  const calculatedPreviewMap = useMemo(() => {
    if (!calculatedPreview) return null;
    const { route } = calculatedPreview;
    const leafletLine = calculatedCarToLeafletCoordinates(route);
    if (!leafletLine) return null;
    const line = calculatedCarLine();
    const center: [number, number] = leafletLine[Math.floor(leafletLine.length / 2)];
    const markers: MapMarker[] = [
      {
        coords: center,
        title: line.title,
        color: 'teal',
        type: MarkerType.POI,
        geometry: {
          type: 'polyline',
          coordinates: leafletLine,
          ...line.style,
        } as MapMarkerGeometry,
      },
      {
        coords: [route.originSnapped.lat, route.originSnapped.lon],
        title: 'Старт на дороге',
        description: `Старт привязан к дороге в ${Math.round(route.originSnapped.snapDistanceM)} м`,
        color: 'orange',
        type: MarkerType.POI,
      },
      {
        coords: [route.destinationSnapped.lat, route.destinationSnapped.lon],
        title: 'Цель на дороге',
        description: `Цель привязана к дороге в ${Math.round(route.destinationSnapped.snapDistanceM)} м`,
        color: 'green',
        type: MarkerType.POI,
      },
    ];
    return { center, markers, caption: line.caption };
  }, [calculatedPreview]);

  // Без трека считать вдоль нечего — тогда прямая и остаётся, но подписана
  // прямой. С треком главным числом становится путь, которым идут.
  //
  // При расхождении данных цифры нет вовсе. Скриншот владельца 11.08: цель
  // «Мыс Маячный» на южном берегу входа в бухту, трек — по дорогам вдоль
  // северного, между ними вода, а экран показывал «20.3 км» и «придём через
  // 5 ч 45 м». Приписать к такому числу оговорку мало: под крупной цифрой
  // оговорка не читается, читается цифра.
  const distToNext = approach?.dataConflict
    ? null
    : approach
    ? approach.totalKm
    : coords && nextWp
    ? haversine(coords.lat, coords.lng, nextWp.lat, nextWp.lng)
    : null;
  const distLabel = distToNext === null ? null
    : distToNext < 1
    ? `${Math.round(distToNext * 1000)} м`
    : `${distToNext.toFixed(1)} км`;

  // ─── Слой хода: осталось · когда придём · сколько прошли ───────────────────
  // Одна большая цифра «осталось» не отвечает на вопрос туриста в поле: идти
  // ли ещё пять часов или это автопереезд (владелец 09.08).

  // Плечи маршрута — основа прогресса. Меряются ВДОЛЬ ТРЕКА, когда трек есть
  // и точки ложатся на него по порядку: «до точки» уже считается по треку
  // (approach), и мерить «пройдено» прямыми значило бы держать на одном
  // экране две разные метрики одного пути — на извилистом горном маршруте
  // они расходятся в полтора раза. Прямые между точками остаются только
  // фолбэком наброска, где пути в данных и нет.
  const legKms = useMemo(() => {
    const straight = waypoints.slice(1).map((w, i) => haversine(waypoints[i].lat, waypoints[i].lng, w.lat, w.lng));
    if (!track || track.length < 2 || !trackDm) return straight;
    const posM = waypoints.map(w => distanceAlongTrack(track, w.lat, w.lng, trackDm));
    if (posM.some(p => p === null)) return straight;
    const legs = posM.slice(1).map((p, i) => ((p as number) - (posM[i] as number)) / 1000);
    // Точка спроецировалась ПОЗАДИ предыдущей — порядок точек не совпадает
    // с направлением трека, и мерка вдоль него лжёт. Честнее прямые.
    if (legs.some(l => l <= 0)) return straight;
    return legs;
  }, [waypoints, track, trackDm]);
  const progress = useMemo(
    () => routeProgress(legKms, currentWpIdx, distToNext),
    [legKms, currentWpIdx, distToNext],
  );
  // Рельеф впереди — от текущего положения до следующей точки. Есть он
  // только когда в данных маршрута реальные высоты: рисовать «↑ 12 м» из шума
  // нельзя, по этому числу человек решает, идти ли сегодня.
  const ahead = useMemo(() => {
    if (!relief || relief.points.length < 2 || !track || !coords || !nextWp) return null;
    // Обе границы отреза — в ОДНОЙ шкале, по треку: и «я здесь», и следующая
    // точка. Смешивать прямые с путём нельзя, это и есть враньё о рельефе.
    // Обе границы — в шкале ПОЛНОГО трека, той же, в которой лежит профиль.
    // Пока шкалы нет (старый ответ API), срез не строится вовсе: показать его
    // в чужой мерке значит соврать о рельефе впереди.
    if (!trackDm) return null;
    const fromM = distanceAlongTrack(track, coords.lat, coords.lng, trackDm);
    const toM = distanceAlongTrack(track, nextWp.lat, nextWp.lng, trackDm);
    if (fromM === null || toM === null || toM <= fromM) return null;
    const r = remainingRelief(relief.points, fromM, toM);
    return r.points.length >= 2 ? r : null;
  }, [relief, track, trackDm, coords, nextWp]);

  /**
   * Состояние восстановления. Считается движком (lib/on-route/recovery) из
   * уже имеющихся фактов: род линии, отход от неё, качество фикса, конфликт
   * данных, наличие карты в телефоне. Экран сам ничего про это не решает.
   */
  const recovery = useMemo(() => recoveryState({
    fidelity: lineFidelity,
    hasTrack: !!track && track.length >= 2,
    userOffTrack: approach?.userOffTrack === true,
    offTrackKm: approach?.approachKm ?? null,
    dataConflict: approach?.dataConflict === true,
    fix,
    mapSaved: savedMap !== null,
    offline: isOffline,
  }), [lineFidelity, track, approach, fix, savedMap, isOffline]);

  const eta = useMemo(
    () => etaHours({
      distanceKm: distToNext ?? 0,
      mode: travelMode,
      recentPaceKmh: paceKmh,
      ascentM: ahead?.ascentM ?? null,
      descentM: ahead?.descentM ?? null,
    }),
    [distToNext, travelMode, paceKmh, ahead],
  );
  /**
   * Пока темпа нет — говорим об этом вслух. Молчаливый прочерк турист читает
   * как поломку (ровно так читалось «0ч 00м» на скрине), а честная строка
   * объясняет, что цифра появится сама.
   */
  const etaNote = eta.hours === null
    ? null
    : eta.basis === 'pace+model'
    ? 'по вашему темпу'
    : travelMode === 'car'
    ? 'оценка по линии маршрута'
    : 'оценка, темп появится через 2–3 минуты';

  // SVG track: normalize lat to y-axis — honest representation of waypoint positions
  /**
   * Схема внизу экрана. Рисуем НАСТОЯЩИЙ трек, если он есть: у маршрута с
   * одной путевой точкой («Мыс Маячный», скрин владельца 09.08) прежняя схема
   * не рисовалась вовсе и экран говорил «выберите маршрут», хотя маршрут был
   * выбран, а трек лежал в ответе API нетронутым.
   *
   * Это вид СВЕРХУ (долгота по горизонтали, широта по вертикали), а не профиль
   * высоты: профиль живёт выше и появляется только на реальных высотах.
   */
  const sketch = useMemo(() => {
    const src: Array<{ lat: number; lng: number }> =
      track && track.length >= 2
        ? track.map(([lat, lng]) => ({ lat, lng }))
        : waypoints;
    if (src.length < 2) return null;

    const lats = src.map(p => p.lat);
    const lngs = src.map(p => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const midLat = (minLat + maxLat) / 2;

    /**
     * Проекция с сохранением пропорций. Растягивать широту и долготу каждую
     * по своей оси нельзя: очертания превращаются в ленту, и «схема трека»
     * начинает врать о форме маршрута (владелец 09.08 — «трек кринж»).
     * Переводим градусы в метры (долгота на 53° короче широты примерно в
     * cos φ раз) и берём ОДИН масштаб по меньшей стороне.
     */
    const M_PER_LAT = 110_574;
    const mPerLng = 111_320 * Math.cos((midLat * Math.PI) / 180);
    const spanX = Math.max((maxLng - minLng) * mPerLng, 1);
    const spanY = Math.max((maxLat - minLat) * M_PER_LAT, 1);
    const W = 320, H = 128, PAD = 12;
    const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
    // Остаток свободного места делим поровну — рисунок стоит по центру.
    const offX = (W - spanX * scale) / 2;
    const offY = (H - spanY * scale) / 2;

    const project = (p: { lat: number; lng: number }) => ({
      x: offX + (p.lng - minLng) * mPerLng * scale,
      // Севернее — выше на экране: ось y в SVG растёт вниз.
      y: H - offY - (p.lat - minLat) * M_PER_LAT * scale,
    });

    return {
      fromTrack: Boolean(track && track.length >= 2),
      points: src.map(project),
      // Кружки — это ВСЕГДА путевые точки, а не вершины трека: иначе
      // «текущая точка» подсвечивалась бы на случайной вершине линии.
      dots: waypoints.map((w, i) => ({ ...project(w), i })),
      // Своя позиция на схеме — самое полезное, что тут может быть. Рисуем
      // только по живому фиксу: устаревшая точка «вы здесь» хуже её отсутствия.
      me: coords && figuresLive ? project(coords) : null,
    };
  }, [track, waypoints, coords, figuresLive]);
  const svgPoints = sketch?.points ?? null;

  // ─── Handlers ──────────────────────────────────────────────────────────────

  function selectRoute(r: { id: string }) {
    try { localStorage.setItem('active_trail_route_id', r.id); } catch { /* ignore */ }
    setShowRouteModal(false);
    setPreview(null);
    setModalQuery('');
    setSelectedDestination(null);
    setSelectedOrigin(null);
    setMapPickMode(null);
    setPickedCoord(null);
    setWaypoints([]);
    setCurrentWpIdx(0);
    // Reset timer via ref — no effect restart, no sensor disruption
    startTimeRef.current = Date.now();
    setElapsed(0);
    fetchRouteWaypoints(r.id);
  }

  // Видим ли инструмент выбора цели — модалкой («Сменить маршрут» поверх
  // навигации) или как ОСНОВНОЙ экран (UX-коррекция владельца 27.08:
  // destination-first — «куда хотите пойти», не «маршрут не выбран»).
  // Поиск и рекомендации живут в ОДНОМ состоянии независимо от того, в
  // каком виде инструмент показан — двух копий логики заводить нельзя.
  const pickerVisible = showRouteModal || (!hasRoute && !isLoadingRoute);

  // Поиск маршрутов по названию места: /api/routes/search знает waypoints
  // (семантика + route_waypoints), «Авачинский» находит все маршруты через него
  useEffect(() => {
    const q = modalQuery.trim();
    clearTimeout(modalSearchRef.current);
    if (!pickerVisible || q.length < 2) { setSearchRoutes([]); setSearching(false); return; }
    setSearching(true);
    modalSearchRef.current = setTimeout(() => {
      fetch(`/api/routes/search?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then((d: unknown) => {
          const rows = (typeof d === 'object' && d !== null ? (d as Record<string, unknown>).routes : null);
          if (!Array.isArray(rows)) { setSearchRoutes([]); return; }
          setSearchRoutes(rows.slice(0, 8).map((r) => {
            const row = r as Record<string, unknown>;
            const names = Array.isArray(row.waypoint_names) ? (row.waypoint_names as string[]) : [];
            // Параллельно именам — их личность (владелец 27.08). Массив может
            // отсутствовать (старый кэш ответа/семантическая ветка без
            // обогащения) — тогда Destination.place для этого маршрута не
            // разрешится, и путь честно уйдёт в «только названием».
            const ids = Array.isArray(row.waypoint_ids) ? (row.waypoint_ids as (string | null)[]) : undefined;
            const lats = Array.isArray(row.waypoint_lats)
              ? (row.waypoint_lats as (string | null)[]).map(v => v == null ? null : Number(v)) : undefined;
            const lngs = Array.isArray(row.waypoint_lngs)
              ? (row.waypoint_lngs as (string | null)[]).map(v => v == null ? null : Number(v)) : undefined;
            return {
              id: String(row.id),
              title: String(row.title),
              difficulty: (row.difficulty_level as string | null) ?? null,
              durationDays: null,
              distanceKm: row.distance_km != null ? Number(row.distance_km) : null,
              imageUrl: null,
              via: names.length > 0 ? names.slice(0, 3).join(' · ') : null,
              lineGrade: (row.line_grade as PassportGrade | null) ?? null,
              waypointNames: names,
              elevationGainM: row.elevation_gain_m != null ? Number(row.elevation_gain_m) : null,
              waypointIds: ids,
              waypointLats: lats,
              waypointLngs: lngs,
            } satisfies RoutePreview;
          }));
        })
        .catch(() => setSearchRoutes([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(modalSearchRef.current);
  }, [modalQuery, pickerVisible]);

  // Адаптер домена Destination к существующей строке пути (владелец 27.08):
  // RouteOption ещё не несёт фото/длительности в днях — честно null, не
  // выдумка; их появление в паспорте маршрута — отдельный вопрос.
  function routeOptionToPreview(o: RouteOption): RoutePreview {
    return {
      id: o.id,
      title: o.title,
      difficulty: o.difficulty,
      durationDays: null,
      distanceKm: o.distanceKm,
      imageUrl: null,
      via: null,
      lineGrade: (o.lineGrade as PassportGrade | null) ?? null,
      waypointNames: o.waypointNames,
      elevationGainM: o.elevationGainM,
      // Расчётный автопуть переживает адаптацию к старой форме RoutePreview
      // (владелец 28.08) — терять его здесь означало бы, что renderPathRow и
      // openPreview не смогут отличить calculated_car от каталожного пути.
      calculated: o.calculated,
    };
  }

  function destinationTitle(d: Destination): string {
    return d.kind === 'place' ? d.title : (d.title ?? 'Точка на карте');
  }

  // Кнопка «указать на карте» — общая для цели И старта (владелец 27.08,
  // PR 3+4 роадмапа): один режим на двоих, target решает, какую сущность
  // создаёт тап. Карта не рисуется, пока человек её явно не открыл.
  //
  // Правка 30.08: тап больше не фиксирует координату мгновенно — он роняет
  // пину (pickMarkers), пина остаётся видна на карте, и только явная кнопка
  // «Поставить точку здесь» превращает её в цель/старт. «Заново» сбрасывает
  // пину, не закрывая карту — поправить промах можно, не открывая режим
  // повторно. Ровно тот путь, который в других навигаторах не нужно
  // объяснять словами.
  function renderMapPickButton(target: 'destination' | 'origin', label: string) {
    const active = mapPickMode === target;
    function openPicker() {
      // Центр — от живой позиции, но зафиксированный ОДИН РАЗ на открытие,
      // не на каждый рендер: иначе всякий GPS-тик менял бы identity center
      // и пересобирал карту (тот же класс бага, что и с panTo в LeafletMap).
      setMapPickCenter(coords ? [coords.lat, coords.lng] : MAP_PICK_DEFAULT_CENTER);
      setMapPickZoom(coords ? 13 : 8);
      setPickedCoord(null);
      setMapPickMode(target);
    }
    function closePicker() {
      setMapPickMode(null);
      setPickedCoord(null);
    }
    function confirmPick() {
      if (!pickedCoord) return;
      const { lat, lon } = pickedCoord;
      if (target === 'origin') {
        setSelectedOrigin({ kind: 'coordinate', lat, lon });
      } else {
        setSelectedDestination({ destination: { kind: 'coordinate', lat, lon }, routeOptions: [] });
        // Новая цель — старый старт мог относиться к прежней карточке;
        // тянуть его за собой значило бы приписать ему смысл, которого
        // никто не выбирал.
        setSelectedOrigin(null);
      }
      closePicker();
    }
    return (
      <>
        <button
          type="button"
          onClick={() => (active ? closePicker() : openPicker())}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium mb-3"
          style={{
            background: active ? 'color-mix(in srgb, var(--ocean) 12%, transparent)' : 'var(--bg-primary)',
            border: `1px solid ${active ? 'var(--ocean)' : 'var(--border)'}`,
            color: active ? 'var(--ocean)' : 'var(--text-secondary)',
          }}>
          <Crosshair className="w-4 h-4 shrink-0" />
          {active ? 'Свернуть карту' : label}
        </button>
        {active && (
          <div className="mb-3">
            <div className="rounded-xl overflow-hidden" style={{ height: 320, border: '1px solid var(--border)' }}>
              <LeafletMap center={mapPickCenter} zoom={mapPickZoom} height="320px" showUserLocation
                markers={pickMarkers}
                onMapClick={(lat, lon) => setPickedCoord({ lat, lon })} />
            </div>
            {pickedCoord ? (
              <div className="flex items-center gap-2 mt-2">
                <p className="flex-1 text-xs text-[var(--text-secondary)]">
                  Точка: {pickedCoord.lat.toFixed(5)}, {pickedCoord.lon.toFixed(5)}
                </p>
                <button type="button" onClick={() => setPickedCoord(null)}
                  className="text-xs font-semibold px-3 py-2 rounded-lg shrink-0"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                  Заново
                </button>
                <button type="button" onClick={confirmPick}
                  className="text-xs font-bold px-3 py-2 rounded-lg shrink-0"
                  style={{ background: 'var(--accent)', color: '#fff' }}>
                  Поставить точку здесь
                </button>
              </div>
            ) : (
              <p className="text-xs mt-2 text-center" style={{ color: 'var(--text-muted)' }}>
                Коснитесь карты, чтобы поставить точку
              </p>
            )}
          </div>
        )}
      </>
    );
  }

  // «Откуда начинаем?» — Origin, независимый от Destination (владелец
  // 27.08, PR 4 роадмапа): своё состояние, меняется отдельно, фиксацию
  // цели не трогает. Текущая позиция — из уже идущего GPS-датчика экрана
  // (coords/gpsError выше), второго опроса геолокации здесь не заводим.
  function renderOriginPicker() {
    if (selectedOrigin) {
      return (
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl mb-3"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Откуда</p>
            <p className="text-sm font-medium text-[var(--text-primary)] truncate">{originLabel(selectedOrigin)}</p>
          </div>
          <button onClick={() => setSelectedOrigin(null)}
            className="text-xs font-semibold shrink-0" style={{ color: 'var(--ocean)' }}>
            Изменить
          </button>
        </div>
      );
    }
    return (
      <div className="mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
          Откуда начинаем?
        </p>
        {coords ? (
          <button
            onClick={() => setSelectedOrigin({
              kind: 'current', lat: coords.lat, lon: coords.lng,
              accuracyM: coords.accuracy ?? undefined,
            })}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium mb-2"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
            <Navigation className="w-4 h-4 shrink-0" style={{ color: 'var(--ocean)' }} />
            Текущая позиция
            {coords.accuracy != null && (
              <span className="text-xs text-[var(--text-muted)]">± {Math.round(coords.accuracy)} м</span>
            )}
          </button>
        ) : (
          <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
            {gpsError
              ? 'Доступ к геопозиции запрещён — разрешите его в браузере, чтобы начинать от текущего места, или укажите точку на карте.'
              : 'Определяем вашу позицию…'}
          </p>
        )}
        {renderMapPickButton('origin', 'Указать точку на карте')}
      </div>
    );
  }

  // Карточка зафиксированной цели — общая для места (из поиска) и координаты
  // (из клика по карте, владелец 27.08, PR 3 роадмапа). Путей к координате
  // сегодня НЕ строится (см. lib/on-route/destination.ts — coordinate-цель
  // не участвует в резолве, routeOptions у неё всегда пуст) — честный отказ,
  // а не тихая пустота: третье состояние правила §4.0, не «нашли 0».
  function renderFixedDestination() {
    if (!selectedDestination) return null;
    const d = selectedDestination.destination;
    const hasOptions = selectedDestination.routeOptions.length > 0;
    return (
      <div>
        <button onClick={() => { setSelectedDestination(null); setSelectedOrigin(null); }}
          className="flex items-center gap-1 text-xs font-semibold mb-3"
          style={{ color: 'var(--ocean)' }}>
          <ChevronLeft className="w-3.5 h-3.5" /> {d.kind === 'coordinate' ? 'К поиску' : 'К местам'}
        </button>
        <p className="text-sm font-semibold text-[var(--text-primary)] mb-0.5">
          {destinationTitle(d)}
        </p>
        {d.kind === 'coordinate' && destinationPinMap && (
          <div className="mb-3">
            <div className="rounded-xl overflow-hidden" style={{ height: 160, border: '1px solid var(--border)' }}>
              <LeafletMap center={destinationPinMap.center} zoom={13} height="160px"
                markers={destinationPinMap.markers} />
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1">{d.lat.toFixed(5)}, {d.lon.toFixed(5)}</p>
          </div>
        )}

        {renderOriginPicker()}

        {/* Выбор способа передвижения (владелец 28.08) — сервер 5B-1
            подключает провайдера только для mode: 'car'; 'foot' остаётся
            честным unsupported до 5B-2. Без явного выбора экран посылал бы
            'foot' всегда, и ветка calculated_car была бы недостижима. */}
        {selectedOrigin && (
          <div className="flex gap-2 mb-3">
            {(['car', 'foot'] as const).map(m => (
              <button key={m} type="button" onClick={() => setBuildTravelMode(m)}
                className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg"
                style={buildTravelMode === m
                  ? { background: 'color-mix(in srgb, var(--ocean) 12%, transparent)', color: 'var(--ocean)', border: '1px solid var(--ocean)' }
                  : { background: 'var(--bg-primary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                {m === 'car' ? 'На автомобиле' : 'Пешком'}
              </button>
            ))}
          </div>
        )}

        {/* Построение пути (Origin → Destination) — машина состояний PR 5A,
            транспорт до сервера — PR 5B-1 (httpRouteBuilder, /api/routes/build):
            idle/building/found/not_found/unsupported/failed. Провайдер за
            сервером не выбран для 'foot' — сегодня этот режим всегда
            unsupported, но уже настоящим сетевым запросом, а не заглушкой. */}
        {renderBuildStatus()}

        {hasOptions ? (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
              {selectedOrigin
                ? 'Готовые треки рядом с целью'
                : `${selectedDestination.routeOptions.length} ${plural(selectedDestination.routeOptions.length, 'путь', 'пути', 'путей')}`}
            </p>
            <div className="space-y-2">
              {selectedDestination.routeOptions.map(o => renderPathRow(routeOptionToPreview(o)))}
            </div>
          </>
        ) : (
          <div className="px-3 py-3 rounded-lg" style={{ background: 'var(--bg-hover)' }}>
            <p className="text-xs font-semibold" style={{ color: 'var(--warning)' }}>Путь не найден</p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              В данных платформы нет маршрута к этой точке — ни трека, ни путевых точек рядом.
              Координата сохранена как цель; ведение по ней платформа пока не предлагает.
            </p>
          </div>
        )}
      </div>
    );
  }

  // Строка пути в выборе: род линии, длина, сложность. Одна на обе секции —
  // группы мест и плоский список рекомендуемых.
  //
  // Расчётный автопуть (r.calculated) — отдельная ветка вывода (владелец
  // 28.08): без GradeChip и без lineGrade, вместо них «Путь на автомобиле»,
  // приблизительные км/мин и бейдж «Рассчитан сейчас» — план запрещает
  // показывать расчёт так, будто это проверенная запись каталога.
  function renderPathRow(r: RoutePreview) {
    if (r.calculated) {
      const km = (r.calculated.distanceM / 1000).toFixed(1);
      const min = Math.round(r.calculated.durationS / 60);
      return (
        <div key={r.id}>
          <button onClick={() => openPreview(r)}
            className="w-full flex items-center gap-3 p-3 rounded-xl text-left"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)] truncate">Путь на автомобиле</p>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0"
                  style={{ background: 'color-mix(in srgb, var(--ocean) 15%, transparent)', color: 'var(--ocean)' }}>
                  Рассчитан сейчас
                </span>
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
                ≈ {km} км · ≈ {min} мин
              </p>
            </div>
            <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--ocean)' }}>На карте</span>
          </button>
          {calculatedPreviewError && (
            <p className="text-xs mt-1 px-3 py-2 rounded-lg"
              style={{ background: 'var(--bg-hover)', color: 'var(--warning)' }}>
              {calculatedPreviewError}
            </p>
          )}
        </div>
      );
    }
    return (
      <div key={r.id}>
        <button onClick={() => openPreview(r)}
          className="w-full flex items-center gap-3 p-3 rounded-xl text-left"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            opacity: previewLoadingId === r.id ? 0.6 : 1,
          }}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)] truncate">{r.title}</p>
              <GradeChip grade={r.lineGrade} />
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
              {r.distanceKm ? `${r.distanceKm} км · ` : ''}
              {r.elevationGainM != null ? `↑ ${r.elevationGainM} м · ` : ''}
              {r.difficulty ? (DIFFICULTY_LABELS[r.difficulty] ?? r.difficulty) : '—'}
              {r.via ? ` · через: ${r.via}` : ''}
            </p>
          </div>
          <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--ocean)' }}>
            {previewLoadingId === r.id ? '…' : 'На карте'}
          </span>
        </button>
        {/* Отказ живёт у своей строки: список остаётся на месте,
            и видно, ЧТО именно не открылось. */}
        {previewError?.id === r.id && (
          <p className="text-xs mt-1 px-3 py-2 rounded-lg"
            style={{ background: 'var(--bg-hover)', color: 'var(--warning)' }}>
            {previewError.text}
          </p>
        )}
      </div>
    );
  }

  // Тап по варианту — ПРЕВЬЮ на карте, не фиксация (как в навигаторе)
  function openPreview(r: RoutePreview) {
    // Расчётный автопуть открывается ЛОКАЛЬНО (владелец 28.08, план
    // рендеринга calculated_car): вся геометрия и метрики уже лежат в
    // r.calculated, запроса к /api/routes/[id] тут нет и быть не должно —
    // синтетический id варианта не идентифицирует запись в базе, и запрос
    // по нему возвращал бы нынешнее честное, но бесполезное «Маршрут не
    // открылся». Геометрия проверяется здесь же: провайдер мог вернуть
    // непригодный GeoJSON, и в этом случае карта не рисуется вовсе.
    if (r.calculated) {
      setCalculatedPreviewError(null);
      if (!calculatedCarToLeafletCoordinates(r.calculated)) {
        setCalculatedPreviewError('Провайдер вернул непригодную геометрию пути — карту показать нельзя.');
        // eslint-disable-next-line no-console
        console.error('calculated_car: непригодная геометрия', r.calculated.provider, r.calculated.geometry);
        return;
      }
      setPreview(null);
      setCalculatedPreview({ title: r.title, route: r.calculated });
      return;
    }
    const cached = previewCacheRef.current.get(r.id);
    if (cached) {
      setPreview({ id: r.id, title: r.title, wps: cached.wps, grade: cached.grade, navigability: cached.navigability });
      return;
    }
    setPreviewLoadingId(r.id);
    setPreviewError(null);
    // Провал загрузки карточки маршрута — это состояние, а не пустота.
    // Раньше все ветки отказа делали молчаливый return: человек нажимал
    // «На карте», ничего не происходило, и он оставался гадать, что сломано —
    // связь, маршрут или приложение (проверка 16.08).
    fetch(`/api/routes/${r.id}`)
      .then(res => res.json())
      .then((j: unknown) => {
        if (typeof j !== 'object' || j === null || !(j as Record<string, unknown>).success) {
          setPreviewError({ id: r.id, text: 'Маршрут не открылся — сервер не отдал данные.' });
          return;
        }
        const data = (j as Record<string, unknown>).data as Record<string, unknown>;
        const wps = data.waypoints;
        if (!Array.isArray(wps)) {
          setPreviewError({ id: r.id, text: 'У маршрута нет точек — вести по нему нельзя.' });
          return;
        }
        const converted: SavedWaypoint[] = (wps as Array<Record<string, unknown>>)
          .filter(w => w.lat != null && w.lng != null)
          .map(w => ({
            lat: Number(w.lat),
            lng: Number(w.lng),
            name: (w.placeName as string | null) ?? `Точка ${Number(w.position) + 1}`,
          }));
        if (converted.length === 0) {
          setPreviewError({ id: r.id, text: 'У точек маршрута нет координат — на карте его не показать.' });
          return;
        }
        // Род данных — из паспорта детального ответа (точнее спискового:
        // он видит сам трек, а не только факт наличия линии); фолбэк — бейдж
        // из списка, если паспорта в ответе нет (старый кэш/билд).
        const pp = data.passport as { grade?: unknown } | null | undefined;
        const grade = (typeof pp?.grade === 'string' ? pp.grade as PassportGrade : null)
          ?? r.lineGrade ?? null;
        // Вердикт приходит С СЕРВЕРА: там есть и линия, и точки. Экран линию
        // не грузит и сам расхождения не увидел бы — «Вулкан Козельский» с
        // точкой в 14 км от трека выглядел бы пригодным до самого поля.
        const nav = (data.navigability as { verdict?: unknown; canLead?: unknown; reasons?: unknown } | null) ?? null;
        const navigability = nav && typeof nav.verdict === 'string'
          ? {
              verdict: nav.verdict as NavigabilityVerdict,
              canLead: nav.canLead === true,
              reasons: Array.isArray(nav.reasons) ? nav.reasons.filter((x): x is string => typeof x === 'string') : [],
            }
          : null;
        previewCacheRef.current.set(r.id, { wps: converted, grade, navigability });
        setPreview({ id: r.id, title: r.title, wps: converted, grade, navigability });
      })
      .catch(() => {
        setPreviewError({ id: r.id, text: 'Не удалось загрузить маршрут — похоже, связь. Повторите.' });
      })
      .finally(() => setPreviewLoadingId(null));
  }

  // Общая загрузка «Рекомендуемых» — нужна и модалке («Сменить маршрут»),
  // и destination-first экрану (UX-коррекция 27.08): один запрос, не два
  // независимых пути, которые могут разойтись.
  function loadRecommendedRoutes() {
    if (modalRoutes.length > 0) return;
    setModalError(null);
    // has_waypoints: в поле рекомендуем только маршруты с реальными точками —
    // статьи-обзоры («Зима на Камчатке») в планировщике не нужны
    fetch('/api/routes?limit=10&sort=recommended&kind=route&has_waypoints=true')
      .then(r => r.json())
      .then((d: unknown) => {
        if (typeof d !== 'object' || d === null || !(d as Record<string, unknown>).success) {
          setModalError('Не удалось загрузить маршруты');
          return;
        }
        const items = ((d as Record<string, unknown>).data as unknown[]).slice(0, 10).map(r => {
          if (typeof r !== 'object' || r === null) return null;
          const row = r as Record<string, unknown>;
          return {
            id: row.id as string,
            title: row.title as string,
            difficulty: (row.difficulty as string | null) ?? null,
            durationDays: row.durationDays != null ? Number(row.durationDays) : null,
            distanceKm: row.distanceKm != null ? Number(row.distanceKm) : null,
            imageUrl: null,
            lineGrade: (row.lineGrade as PassportGrade | null) ?? null,
          } satisfies RoutePreview;
        }).filter(Boolean) as RoutePreview[];
        if (items.length === 0) setModalError('Маршруты не найдены');
        else setModalRoutes(items);
      })
      .catch(() => { setModalError('Ошибка сети — проверьте соединение'); });
  }

  function renderDestinationPicker(): React.ReactNode {
    return (
      calculatedPreview && calculatedPreviewMap ? (
                    /* ── Превью РАССЧИТАННОГО автопути (владелец 28.08) ──
                       Отдельная ветка от превью каталожного варианта ниже:
                       своя карта (calculatedPreviewMap, не previewMap), свои
                       факты под картой, и НАМЕРЕННО нет кнопки старта — это
                       первый релиз, mayNavigate/mayPersist у первого
                       провайдера решены false: только информационный
                       автоподъезд, не инструмент полевой навигации. ── */
                    <div>
                      <div className="rounded-xl overflow-hidden mb-3" style={{ height: 220, border: '1px solid var(--border)' }}>
                        <LeafletMap markers={calculatedPreviewMap.markers} center={calculatedPreviewMap.center} zoom={11} height="220px" showUserLocation />
                      </div>
                      <p className="text-sm font-medium text-[var(--text-primary)] mb-0.5">{calculatedPreview.title}</p>
                      {/* Подпись линии — НЕИЗМЕННА по контракту calculatedCarLine():
                          экран может дополнить фактами ниже, но не укоротить её. */}
                      <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
                        {calculatedPreviewMap.caption}
                      </p>
                      {/* Три факта под картой — план §4: дата расчёта, трафик,
                          провайдер. Длительность с трафиком читается как
                          ориентировочная на момент расчёта, не как обещание. */}
                      <div className="space-y-1 mb-3 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-hover)' }}>
                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          Рассчитан {new Date(calculatedPreview.route.builtAt).toLocaleString('ru-RU')}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          Пробки {calculatedPreview.route.traffic ? 'учтены' : 'не учитывались'}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          Построил {calculatedPreview.route.provider}
                        </p>
                      </div>
                      {/* Разрешение mayDisplay уже проверено сервером (applySnapGuard
                          понижает дальний snap в not_found раньше, чем этот вариант
                          вообще появится в списке) — здесь достаточно честно
                          показать отказ, если он всё же пришёл false. */}
                      {!calculatedPreview.route.mayDisplay && (
                        <p className="text-xs mb-3 px-3 py-2 rounded-lg"
                          style={{ background: 'var(--bg-hover)', color: 'var(--warning)' }}>
                          Провайдер не разрешил показать геометрию этого пути.
                        </p>
                      )}
                      <button onClick={() => setCalculatedPreview(null)}
                        className="w-full text-xs font-semibold px-4 py-2.5 rounded-lg"
                        style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                        К вариантам
                      </button>
                      {/* Кнопки «Начать маршрут» здесь нет НАМЕРЕННО — не временный
                          пропуск, а mayNavigate: false первого релиза (план §3):
                          передавать эту линию в полевой навигатор или считать по
                          ней прогресс нельзя, пока лицензия и офлайн-поведение
                          провайдера не проверены отдельно. mayPersist: false —
                          по той же причине путь не сохраняется ни в офлайн-пакет,
                          ни в историю: он существует только в этом состоянии
                          экрана и исчезает вместе с ним. */}
                    </div>
      ) : preview && previewMap ? (
                    /* ── Превью варианта на карте (фиксация только кнопкой) ── */
                    <div>
                      <div className="rounded-xl overflow-hidden mb-3" style={{ height: 220, border: '1px solid var(--border)' }}>
                        {/* height обязателен: без него LeafletMap берёт дефолт 400px в
                            220px overflow-hidden контейнере — fitBounds центрирует
                            маркеры в обрезанную нижнюю половину, и превью выглядит
                            пустым (скрин владельца «Авачинский перевал»). */}
                        {/* «Где точка моего местонахождения?» — вопрос владельца на
                            превью «Куда идём?» 17.08. Решение «идти или нет»
                            принимают именно здесь, и принять его, не видя себя,
                            нельзя: три зелёных кружка на карте края ничего не
                            говорят о том, рядом это или за перевалом.
                            Синяя точка рождается только по настоящему фиксу
                            (см. LeafletMap) и в fitBounds не участвует — превью
                            маршрута от неё не разъедется. */}
                        <LeafletMap markers={previewMap.markers} center={previewMap.center} zoom={11} height="220px" showUserLocation />
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-[var(--text-primary)]">{preview.title}</p>
                        <GradeChip grade={preview.grade} />
                      </div>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5 mb-3">
                        {preview.wps.length} {plural(preview.wps.length, 'точка', 'точки', 'точек')}
                        {preview.wps.length > 1 && ` · ${preview.wps[0].name} → ${preview.wps[preview.wps.length - 1].name}`}
                      </p>
                      {/* Оговорка паспорта: что этот род данных значит для ног.
                          Бейдж прочитает не каждый — слова прочитают все. */}
                      {preview.grade && passportGradeNote(preview.grade) && (
                        <p className="text-xs mb-3 px-3 py-2 rounded-lg"
                          style={{ background: 'var(--bg-hover)', color: 'var(--warning)' }}>
                          {passportGradeNote(preview.grade)}
                        </p>
                      )}
                      {/* ── Черта: одна причина отказа, названная словами ──────────
                          Раньше экран судил сам — отдельно про разброс, отдельно
                          про одиночную точку, — и не видел третьего случая:
                          расхождения точек с линией. «Вулкан Козельский» проходил
                          оба здешних теста и оказывался непригодным только в поле.
                          Теперь вердикт приходит с сервера, где есть и линия, и
                          точки, а экран его показывает. */}
                      {preview.navigability && preview.navigability.reasons.length > 0 && (
                        <div className="mb-3 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-hover)' }}>
                          <p className="text-xs font-semibold" style={{ color: 'var(--warning)' }}>
                            {preview.navigability.verdict === 'not_on_foot'
                              // Не отказ, а другой род записи: у облёта линию не
                              // проходят по земле, и мерки тропы к ней не относятся.
                              ? 'Это не пеший маршрут'
                              : preview.navigability.verdict === 'not_a_route'
                                ? 'Вести по этой записи нельзя'
                                : 'Ведение по линии не обещаем'}
                          </p>
                          {preview.navigability.reasons.map((why, i) => (
                            <p key={i} className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{why}</p>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button onClick={() => setPreview(null)}
                          className="flex-1 text-xs font-semibold px-4 py-2.5 rounded-lg"
                          style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                          К вариантам
                        </button>
                        {/* Кнопки нет вовсе, когда записью нельзя пользоваться как
                            маршрутом: предлагать старт по подборке мест значило бы
                            обещать путь, которого нет. */}
                        {(() => {
                          const verdict = preview.navigability?.verdict
                            // Вердикт не пришёл (старый кэш ответа) — судим по тому,
                            // что видно здесь: одна точка или разброс. Отсутствие
                            // ответа не превращается в «пригодно».
                            ?? (previewMap.scattered || previewMap.singlePoint ? 'not_a_route' : 'orientation_only');
                          const label = navigabilityCtaLabel(verdict);
                          if (!label) return null;
                          return (
                            <button onClick={() => selectRoute(preview)}
                              className="flex-1 text-xs font-bold px-4 py-2.5 rounded-lg"
                              style={verdict === 'navigable'
                                ? { background: 'rgba(74,222,128,0.15)', color: 'var(--success)', border: '1px solid rgba(74,222,128,0.3)' }
                                : { background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                              {label}
                            </button>
                          );
                        })()}
                      </div>
                    </div>
                  ) : (
                    <div>
                      {selectedDestination ? renderFixedDestination() : (
                      <>
                      {/* Поиск по названию места */}
                      <input
                        type="text"
                        value={modalQuery}
                        onChange={e => { setModalQuery(e.target.value); setSelectedDestination(null); setSelectedOrigin(null); setMapPickMode(null); setPickedCoord(null); }}
                        placeholder="Название места: Авачинский, Толбачик…"
                        className="w-full px-3 py-2.5 rounded-xl text-sm mb-3"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />

                      {/* Клик по карте — вторая цель, не только текстом
                          (владелец 27.08, PR 3 роадмапа). Режим — по кнопке,
                          не сам по себе: карта не рисуется, пока человек её
                          явно не открыл, и гаснет сразу после тапа — без
                          автозапуска ориентирования. */}
                      {renderMapPickButton('destination', 'Указать точку на карте')}

                      {modalError && modalQuery.trim().length < 2 ? (
                        <div className="flex flex-col items-center gap-3 py-6">
                          <p className="text-[var(--danger)] text-sm text-center">{modalError}</p>
                          <button
                            onClick={() => { setModalError(null); openRouteModal(); }}
                            className="text-xs font-semibold px-4 py-2 rounded-lg"
                            style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                            Попробовать снова
                          </button>
                        </div>
                      ) : (
                        <div>
                          {modalQuery.trim().length >= 2 ? (
                            /* ── Сначала цель, потом путь (владелец 27.08):
                                совпавшее место — отдельная карточка ЦЕЛИ, а
                                непроверенная линия — вариант пути ВНУТРИ неё,
                                не сама цель. Совпавшие только названием
                                маршрута — своей секцией, честно подписанной:
                                настоящей цели за ними нет. ── */
                            searchRoutes.length === 0 ? (
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                                  {searching ? 'Ищем пути…' : `Пути к «${modalQuery.trim()}»`}
                                </p>
                                <div className="text-[var(--text-muted)] text-sm text-center py-6">
                                  {searching ? 'Секунду…' : 'Ничего не нашлось — попробуйте другое место'}
                                </div>
                              </div>
                            ) : (() => {
                              const { destinations, titleOnly } = groupRoutesByDestination(searchRoutes, modalQuery.trim());

                              return (
                                <div className="space-y-4">
                                  {destinations.length > 0 && (
                                    <div>
                                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                                        Места
                                      </p>
                                      <div className="space-y-2">
                                        {destinations.map(d => (
                                          <button key={d.destination.kind === 'place' ? d.destination.id : `${d.destination.lat},${d.destination.lon}`}
                                            onClick={() => { setSelectedDestination(d); setSelectedOrigin(null); }}
                                            className="w-full flex items-center gap-3 p-3 rounded-xl text-left"
                                            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
                                            <div className="flex-1 min-w-0">
                                              <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                                                {destinationTitle(d.destination)}
                                              </p>
                                              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                                {d.routeOptions.length} {plural(d.routeOptions.length, 'путь', 'пути', 'путей')}
                                              </p>
                                            </div>
                                            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {titleOnly.length > 0 && (
                                    <div>
                                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                                        Совпали названием маршрута
                                      </p>
                                      <div className="space-y-2">
                                        {titleOnly.map(o => renderPathRow(routeOptionToPreview(o)))}
                                      </div>
                                    </div>
                                  )}
                                  {destinations.length === 0 && titleOnly.length === 0 && (
                                    <div className="text-[var(--text-muted)] text-sm text-center py-6">
                                      Ничего не нашлось — попробуйте другое место
                                    </div>
                                  )}
                                </div>
                              );
                            })()
                          ) : (
                            <div>
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                                Рекомендуемые
                              </p>
                              {modalRoutes.length === 0 ? (
                                <div className="text-[var(--text-muted)] text-sm text-center py-6">
                                  Загрузка маршрутов…
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  {modalRoutes.map(r => renderPathRow(r))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      </>
                      )}
                    </div>
      )
    );
  }

  function openRouteModal() {
    setShowRouteModal(true);
    loadRecommendedRoutes();
  }

  // Destination-first (UX-коррекция владельца 27.08): без активного маршрута
  // экран сам по себе — инструмент выбора цели, рекомендации грузятся сразу,
  // без клика «Выбрать маршрут». Загрузка — один раз на появление состояния.
  useEffect(() => {
    if (!hasRoute && !isLoadingRoute) loadRecommendedRoutes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRoute, isLoadingRoute]);

  // Построение пути Origin → Destination (владелец 27.08, PR 5A роадмапа).
  // Запускается, только когда ОБЕ независимые сущности выбраны — origin сам
  // по себе путь не строит (см. renderOriginPicker). cancelled — стандартная
  // отмена устаревшего запроса: смена origin/destination перезапускает
  // эффект, и cleanup гасит результат предыдущего до его прихода, так что
  // экран никогда не покажет ответ для уже оставленной пары.
  useEffect(() => {
    if (!selectedOrigin || !selectedDestination) {
      setBuildPhase({ phase: 'idle' });
      return;
    }
    let cancelled = false;
    setBuildPhase({ phase: 'building' });
    httpRouteBuilder
      .build({ origin: selectedOrigin, destination: selectedDestination.destination, mode: buildTravelMode })
      .then(result => { if (!cancelled) setBuildPhase({ phase: 'done', result }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBuildPhase({
          phase: 'done',
          result: { status: 'failed', retryable: true, message: err instanceof Error ? err.message : 'Не удалось построить путь' },
        });
      });
    return () => { cancelled = true; };
  }, [selectedOrigin, selectedDestination, buildRetryTick, buildTravelMode]);

  // Карточка ответа машины состояний — единственное место, где текст
  // «путь не найден»/«недоступно»/«не удалось» решается по РЕАЛЬНОМУ
  // результату build(), а не пишется заранее в JSX (§4.0: третье
  // состояние — «не смогли построить» не то же самое, что «нашли 0»).
  function renderBuildStatus() {
    if (buildPhase.phase === 'idle') return null;
    if (buildPhase.phase === 'building') {
      return (
        <div className="px-3 py-3 rounded-lg mb-3" style={{ background: 'var(--bg-hover)' }}>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Ищем путь от старта до цели…</p>
        </div>
      );
    }
    const { result } = buildPhase;
    if (result.status === 'found') {
      // Заголовок называет способ явно (владелец 28.08, план рендеринга
      // calculated_car): «Автомобильный путь…», не «Маршрут» и не «Трек
      // рядом с целью» — иначе только что рассчитанный подъезд читается как
      // запись из каталога готовых туристических путей, а это не так.
      const heading = buildTravelMode === 'car'
        ? 'Автомобильный путь от вашего старта'
        : 'Путь от вашего старта';
      return (
        <div className="mb-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
            {heading}
          </p>
          <div className="space-y-2">
            {result.options.map(o => renderPathRow(routeOptionToPreview(o)))}
          </div>
        </div>
      );
    }
    const label =
      result.status === 'not_found' ? 'Путь не найден'
      : result.status === 'unsupported' ? 'Построение пути пока недоступно'
      : 'Не удалось построить путь';
    const detail = result.status === 'failed' ? result.message : result.reason;
    return (
      <div className="px-3 py-3 rounded-lg mb-3" style={{ background: 'var(--bg-hover)' }}>
        <p className="text-xs font-semibold" style={{ color: 'var(--warning)' }}>{label}</p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{detail}</p>
        {result.status === 'failed' && result.retryable && (
          <button onClick={() => setBuildRetryTick(t => t + 1)}
            className="text-xs font-semibold mt-2" style={{ color: 'var(--ocean)' }}>
            Повторить
          </button>
        )}
      </div>
    );
  }

  // ─── Полевые действия: место · трек · наблюдение (владелец 27.08) ─────────
  // Панель — та же, что на /field-check (FieldActionBar, образец MAPS.ME):
  // одно касание — одно действие. «Наблюдение» переехало сюда с главной:
  // здесь у него есть контекст — координаты и офлайн-статус система знает
  // сама. Запись трека уходит ТЕМ ЖЕ приёмником, что у /field-check.

  const recorder = useTrackRecorder();
  const [obsOpen, setObsOpen] = useState(false);
  const obsQueueLen = useTrailObservationQueue();
  const [fieldBarError, setFieldBarError] = useState<string | null>(null);

  // Deep-link с главной («Сообщить о наблюдении… →») обязан открывать САМУ
  // форму, а не приземлять на общий полевой экран (владелец 29.08: ссылка
  // ведёт на /planning?mode=trail&obs=1, а без этого флага человек видел
  // «Куда хотите пойти?» вместо формы, которую ему обещали заголовком —
  // тот же класс дефекта, что чинили 27.08 для самой кнопки «Наблюдение»,
  // только теперь про то, что показывается ПЕРВЫМ).
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get('obs') === '1') setObsOpen(true);
    } catch { /* ignore */ }
  }, []);
  const [sendingTrack, setSendingTrack] = useState(false);

  /**
   * Отказ СЕРВЕРА, показанный человеку. Не то же самое, что «связи нет».
   *
   * «Отправим при связи» — правда, когда запрос не доехал, и ЛОЖЬ, когда он
   * доехал и сервер ответил «класть некуда» (например, файловое хранилище не
   * настроено — тогда трек не уедет ни завтра, ни через месяц). Обещание,
   * которое не сбудется никогда, — это то же самое молчание, из-за которого
   * трек владельца пропал 29.08, только вежливее (§4.0 CLAUDE.md).
   */
  const [trackRefusal, setTrackRefusal] = useState<string | null>(null);

  // Общий шаг отправки — вызывается и явным «Остановить», и тихим автодожимом
  // (ниже). Возвращает null при успехе, иначе — причину И ЕЁ РОД: `refused`
  // значит, что запрос дошёл до сервера и получил отказ, а не потерялся в
  // дороге. Эти два исхода лечатся по-разному, поэтому и различаются.
  const sendTrackGpx = useCallback(async (
    gpx: string,
  ): Promise<{ reason: string; refused: boolean } | null> => {
    try {
      const b64 = typeof window === 'undefined'
        ? '' : btoa(unescape(encodeURIComponent(gpx)));
      const res = await fetch('/api/field-check/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: b64,
          filename: `${activeRouteTitle || 'na-marshrute'}.gpx`,
        }),
      });
      const data = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!res.ok || !data?.success) {
        return {
          // Код ответа — в текст: без него «сервер отказал» неотличимо от
          // «сервер промолчал», а разбирать потом придётся вслепую.
          reason: data?.error ?? `Сервер не принял трек (код ${res.status}). Запись цела на телефоне`,
          refused: true,
        };
      }
      return null;
    } catch {
      return {
        reason: 'Связи нет — трек сохранён на телефоне, отправится при связи',
        refused: false,
      };
    }
  }, [activeRouteTitle]);

  const stopAndSendTrack = useCallback(async () => {
    setFieldBarError(null);
    const done = await recorder.stop();
    if (done === null) {
      setFieldBarError(recorder.error ?? 'Записывать было нечего');
      return;
    }
    if (done.summary.quality === 'poor') {
      setFieldBarError(done.summary.reasons[0] ?? 'Запись вышла рваной');
    }
    setSendingTrack(true);
    const fail = await sendTrackGpx(done.gpx);
    setSendingTrack(false);
    if (fail) {
      setFieldBarError(fail.reason);
      setTrackRefusal(fail.refused ? fail.reason : null);
      return;
    }
    await recorder.discard();
    setTrackRefusal(null);
    setFieldBarError(null);
  }, [recorder, sendTrackGpx]);

  /**
   * Автодожим недописанного трека при возврате связи (владелец 30.08: трек
   * записан в поле, «Остановить» нажато без сети, кнопка честно обещала
   * «отправится при связи» — а фактически ждала, что человек сам ЕЩЁ РАЗ
   * зайдёт в запись и остановит её. У наблюдений (useTrailObservationQueue,
   * ObservationSheet.tsx) такой автодожим по событию `online` уже есть —
   * трек был единственным полевым действием без него.
   *
   * Не мешает активной записи (recording=true) — там отправкой распоряжается
   * stopAndSendTrack по явному нажатию. Молчит на повторном отказе: это
   * фоновая попытка, которую никто не нажимал, крутить баннер ошибки не о
   * чем — черновик остаётся на диске и получит ещё одну попытку на
   * следующее online.
   */
  /**
   * ── Правка 30.08 (второй заход): дожим ещё и при ОТКРЫТИИ экрана ────────
   *
   * Событие `online` возникает только на ПЕРЕХОДЕ офлайн→онлайн. Трек,
   * остановленный без сети, ждал именно перехода — а человек возвращался в
   * город и открывал приложение УЖЕ при связи. Перехода не было, событие не
   * приходило, черновик оставался на диске навсегда, и единственным следом
   * была тихая подпись «есть недописанная» на кнопке.
   *
   * Так пропал трек владельца от 5 стройки: в `route_track_imports` ноль
   * строк за всё время. Человек считал, что записал путь, — и путь исчез.
   *
   * Поэтому вторая точка входа — появление черновика на диске (`restored`):
   * хук вычитывает его асинхронно, и к этому моменту уже известно, есть ли
   * что слать.
   *
   * Два замка, потому что они защищают от разного:
   *   inFlight — от одновременной отправки (событие и монтирование совпали);
   *   autoTried — от повторов в цикле: `recorder` пересоздаётся на каждом
   *     рендере, значит эффект по нему готов срабатывать бесконечно.
   * Настоящее возвращение связи замок autoTried снимает: это новый повод.
   */
  const trackFlushInFlightRef = useRef(false);
  const trackAutoTriedRef = useRef(false);

  const flushTrackDraft = useCallback(() => {
    if (trackFlushInFlightRef.current || recorder.recording) return;
    // navigator.onLine врёт в плюс (говорит «есть» при мёртвом Wi-Fi), но не
    // врёт в минус: явное false — это точно не время слать.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const pkg = recorder.packageDraft();
    if (!pkg) return;
    trackFlushInFlightRef.current = true;
    void sendTrackGpx(pkg.gpx)
      .then(fail => {
        if (!fail) {
          setTrackRefusal(null);
          setFieldBarError(null);
          void recorder.discard();
          return;
        }
        // Не доехало — не новость: черновик ждёт связи, как и обещано, и
        // баннер на попытку, которую никто не нажимал, крутить не о чем.
        // А вот ОТКАЗ сервера — новость: он не рассосётся сам, и человек
        // должен знать, что ждать связи бессмысленно.
        if (fail.refused) {
          setTrackRefusal(fail.reason);
          setFieldBarError(fail.reason);
        }
      })
      .finally(() => { trackFlushInFlightRef.current = false; });
  }, [recorder, sendTrackGpx]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOnline = () => {
      // Связь вернулась по-настоящему — это новый повод, прошлый отказ его
      // не отменяет.
      trackAutoTriedRef.current = false;
      flushTrackDraft();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushTrackDraft]);

  useEffect(() => {
    if (!recorder.restored || trackAutoTriedRef.current) return;
    trackAutoTriedRef.current = true;
    flushTrackDraft();
  }, [recorder.restored, flushTrackDraft]);

  /**
   * Отказ приёма — в баннер, целой фразой с причиной.
   *
   * Подпись на кнопке скажет «точки не пишутся», но не скажет ПОЧЕМУ и что
   * делать. Человек в машине должен узнать это в ту минуту, когда ещё может
   * поправить (выйти на открытое место, дождаться спутников), а не назавтра
   * по пустой таблице — как вышло 31.08.
   */
  useEffect(() => {
    if (recorder.rejecting) setFieldBarError(recorder.rejecting);
  }, [recorder.rejecting]);

  // Порядок — по плану владельца: «Добавить место · Записать трек · Наблюдение».
  // Кнопка, которую нажать нельзя, не показывается (правило FieldActionBar).
  const fieldActions = useMemo<FieldAction[]>(() => {
    const list: FieldAction[] = [];
    const canGeo = typeof navigator !== 'undefined' && !!navigator.geolocation;

    if (canGeo) {
      list.push({
        id: 'place',
        // «Добавить место» конфликтовало по смыслу с destination-first
        // экраном (UX-коррекция владельца 27.08): там «место» — цель
        // маршрута, здесь — полевая находка. Разные вещи, разные слова.
        label: 'Сообщить о месте',
        icon: <MapPinPlus className="w-6 h-6" />,
        // Жёсткий переход, не Link: полевой контур живёт без гидрации.
        // Форма находки на /field-check открывается сразу (?place=1).
        onPress: () => { window.location.assign('/field-check?place=1'); },
      });
      list.push({
        id: 'track',
        label: recorder.recording ? 'Остановить' : 'Записать трек',
        // Глиф — из пака владельца (vedara_field_icons_v2, lucide route):
        // цвет не зашивается, красится токенами панели.
        icon: recorder.recording
          ? <Square className="w-6 h-6" fill="currentColor" />
          : <Route className="w-6 h-6" />,
        active: recorder.recording,
        busy: sendingTrack,
        onPress: () => {
          if (recorder.recording) { void stopAndSendTrack(); return; }
          recorder.start(activeRouteTitle || 'На маршруте');
        },
        // Таймер + дистанция (док владельца): идущая запись видна числами.
        hint: recorder.recording
          // Отказ приёма важнее счётчиков: цифры «0 тчк · 0.0 км» формально
          // не врут, но человек за рулём читает не их, а «идёт запись».
          ? (recorder.rejecting
              ? 'точки не пишутся'
              : recorder.silent
              ? 'сигнала нет'
              : [
                  recorder.summary.durationMin != null ? `${recorder.summary.durationMin} мин` : null,
                  `${recorder.summary.points} тчк`,
                  `${recorder.summary.lengthKm.toFixed(1)} км`,
                ].filter(Boolean).join(' · '))
          // Черновик на диске — это НЕ «ничего не происходит». Прежнее «есть
          // недописанная» не говорило главного: запись цела и ждёт отправки,
          // а не потеряна. Человек, у которого трек не дошёл, читал это как
          // «что-то недоделано» и шёл дальше.
          // Отказ сервера вытесняет обещание: «отправим при связи» при
          // мёртвом приёмнике — обещание, которое не сбудется никогда.
          : (recorder.restored
              ? (trackRefusal
                  ?? `запись сохранена${sendingTrack ? ', отправляем' : ', отправим при связи'}`)
              : null),
      });
    }

    list.push({
      id: 'observation',
      label: 'Наблюдение',
      icon: <Binoculars className="w-6 h-6" />,
      badge: obsQueueLen > 0 ? obsQueueLen : null,
      onPress: () => setObsOpen(true),
    });

    return list;
  }, [recorder, sendingTrack, stopAndSendTrack, activeRouteTitle, obsQueueLen, trackRefusal]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative min-h-[calc(100vh-56px)]" style={{ color: 'var(--text-primary)' }}>
      {/* Карта — постоянный базовый слой экрана (редизайн 29.08, по мокапу
          владельца), а не то, что открывается по кнопке. Центр не следует за
          живыми coords (см. комментарий у mapCenter выше) — идентичность
          center/markers меняется только по явному действию (кнопка «Карта»,
          выбор маршрута), не на каждом GPS-тике.
          Маркеры — по режиму: в фоне (showMap=false) только линия
          (backgroundMapMarkers, правка 29.08 — numbered-пины путевых точек
          иначе торчат в промежутках между карточками), в фокус-режиме
          «Карта» — полный набор точек, как и был. Смена набора при
          переключении showMap — законный, разовый, пользователем
          инициированный ремонт карты, того же рода, что уже есть у смены
          mapCenter по кнопке «Карта». */}
      <div className="fixed inset-0 z-0">
        <LeafletMap
          markers={showMap ? mapMarkers : backgroundMapMarkers}
          center={mapCenter}
          zoom={12}
          height="100dvh"
          showUserLocation
        />
      </div>

      {/* Весь приборный столбец — поверх карты. В режиме «Карта» (showMap)
          прячется целиком: карта та же самая (не второй экземпляр), просто
          ничто не закрывает её и не ловит тапы поверх нужного места. */}
      <div className={`relative z-10 flex flex-col ${showMap ? 'hidden' : ''}`}>
      {/* Единый слот статуса под шапкой (редизайн 29.08, Шаг 2) — приборная
          строка и строка состояния сидят в одной стеклянной плашке
          (.fx-glass, контекстный слой §2 CLAUDE.md), а не двумя разными
          цветными полосами на всю ширину. Это НЕ RecoveryCard: та карточка —
          предупреждение/действие, ей по контракту положена непрозрачность
          («критичные приборы и действия... offline/предупреждения...
          всегда непрозрачные») и своё место НИЖЕ компаса и дистанции
          (recovery.ts, правило 3) — не трогаем её позицию и фон. */}
      {(hasRoute || status) && (
        <div className="fx-glass mx-3 mt-3 rounded-2xl overflow-hidden">
          {hasRoute && (
            <FieldStatusStrip
              fixLabel={fix.state === 'live' && fix.accuracyM != null ? `GPS ±${Math.round(fix.accuracyM)} м` : fixLabel(fix)}
              fixLive={figuresLive}
              routeTitle={activeRouteTitle}
              checkpoint={waypoints.length > 1
                ? { current: Math.min(currentWpIdx + 1, waypoints.length), total: waypoints.length }
                : null}
              dataLine={savedMap
                ? `Карта сохранена${packStates?.find(s => s.kind === 'safety_snapshot')?.note
                    ? ` · ${packStates.find(s => s.kind === 'safety_snapshot')!.note.toLowerCase()}`
                    : ''}`
                : 'Карта не сохранена — в поле не откроется'}
              dataOk={Boolean(savedMap)}
            />
          )}

          {/* Одна строка состояния вместо стека отчётов о датчиках. Тишина —
              это тоже сообщение: всё в порядке, идите.
              Подавляется, только когда RecoveryCard РЕАЛЬНО отрендерится и
              скажет о том же факте подробнее и с действием (нужен hasRoute —
              карточка рисуется только при активном маршруте, иначе некому
              подхватить сообщение и оно просто исчезло бы). stale_fix ⊇
              «сигнал потерян»/«ищем спутники» из status — иначе тот же факт
              звучит дважды подряд на одном экране (friction #1 аудита
              29.08). Остальные ветки status (разрешение геолокации,
              офлайн-ступень, компас) recovery
              не знает вовсе — их подавлять нечем и незачем. */}
          {status && !(hasRoute && recovery.kind === 'stale_fix') && (
            <div
              className="flex items-center gap-2 px-4 py-2.5 text-xs"
              style={{
                color: status.tone === 'warn' ? 'var(--warning)' : 'var(--text-secondary)',
              }}
            >
              {status.tone === 'warn'
                ? <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                : isOffline ? <WifiOff className="w-3.5 h-3.5 shrink-0" /> : <MapPin className="w-3.5 h-3.5 shrink-0" />}
              <span className="flex-1">{status.text}</span>
              {/* Кнопки «Включить» здесь больше нет: лекарство живёт на самом
                  приборе (две кнопки одного действия расходятся поведением —
                  урок SOS #887). Строка только называет состояние. */}
            </div>
          )}
        </div>
      )}

      {/* Компас — над картой, справа, НЕ fixed (правка 29.08 №2, по живому
          скрину владельца: fixed top-28 угадывал отступ пиксельно и наехал
          на геройскую цифру, как только плашка статуса оказалась выше
          предположенного — тот же класс ошибки, что с text-shadow в Шаге 1,
          только в вёрстке, а не в контрасте). Обычный поток вместо
          fixed-угадайки — высота соседей сама раздвигает компас, коллизия
          физически невозможна независимо от длины текста наверху или
          цифры (7921 км/±64642 м с реального скрина — ровно тот случай
          переполнения, которого угадывание не предвидело).
          Сам компас остаётся полностью непрозрачным (FieldCompass не
          тронут) — «критичные приборы... всегда непрозрачные» (§2
          CLAUDE.md), это не глянцевая плашка. */}
      {(hasRoute || isLoadingRoute) && !showMap && (
        <div className="relative z-20 flex justify-end px-3 pt-2">
          <div className="flex flex-col items-center gap-2">
            {/* size=300 — дефолт компонента, рассчитанный на центр колонки
                (прежнее место). Плавающий инструмент — бейдж, не герой
                экрана: 110 примерно соответствует масштабу на мокапе. */}
            <FieldCompass heading={effHeading} state={effCompassState}
              targetBearing={targetBearing} headingSource={headingSource} size={110} />
            {/* Лекарство — на самом приборе: кнопка в строке статуса от
                мёртвого компаса жила в другом углу экрана, и их не связывали. */}
            {compassState === 'blocked' && (
              <button onClick={enableCompass}
                className="text-xs font-semibold px-3 py-2 rounded-lg whitespace-nowrap"
                style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)' }}>
                Включить компас
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main content — единый bottom sheet, а не обычный поток документа
          (правка 30.08, по живому скрину владельца: «информационная панель
          прячет карту с треком»). Геройская карточка и всё, что рендерится
          под ней — панель действий, восстановление, прогресс, коридор,
          высота, продольный график, офлайн-статус, доверие, «Проложить
          дорогу», сетка действий — раньше просто росли вниз от компаса
          обычным потоком и на насыщенном маршруте перекрывали собой почти
          весь экран, включая ту самую полосу карты, где видны трек и
          человек. Ровно то, ради чего затевался Шаг 1 (карта — постоянный
          фон), схлопывалось контентом поверх неё.
          fixed+max-h+overflow-y-auto держат верхнюю часть карты (и компас
          со статусом, которые остаются в обычном потоке ВЫШЕ и ничего не
          знают об этой обёртке) видимой ВСЕГДА, сколько бы блоков ни
          решило отрендериться внизу — они прокручиваются сами, в своей
          собственной области. */}
      {/* Правка 30.08 №3: 60vh, потом 45vh — на живом устройстве владельца
          всё ещё «окно очень много места занимает». 32vh — тот же принцип
          (лист не растёт выше своего потолка, что бы ни решило
          отрендериться внутри), цифра ощутимо меньше: карта теперь видна
          на большей части экрана, а не только в узкой полосе сверху. */}
      <div className="fixed inset-x-0 bottom-0 z-10 max-h-[32vh] overflow-y-auto overscroll-contain">
      <div className="flex justify-center pt-1.5 pb-1">
        <span className="w-9 h-1 rounded-full" style={{ background: 'var(--border)' }} />
      </div>
      <div className="px-4 pb-6 flex flex-col items-center gap-6 max-w-sm mx-auto w-full">

        {!hasRoute && !isLoadingRoute ? (
          /* Destination-first (UX-коррекция владельца 27.08): цель, не
             готовый трек, — первый объект выбора. Прежде здесь стояла
             приборная заглушка с кнопкой, открывающей тот же поиск местом
             ВНУТРИ модалки; теперь это один и тот же инструмент
             (renderDestinationPicker), показанный сразу как основной экран,
             без клика и без чёрной подложки поверх карты. */
          <div className="w-full flex flex-col gap-5 py-6">
            {/* Текст лежит прямо на карте (редизайн 29.08) — своей карточки у
                заголовка нет и не будет (вложенные карточки запрещены §2), а
                text-shadow держит его читаемым на любой подложке тайлов, не
                пряча карту под сплошной плашкой. */}
            <div className="text-center" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.7)' }}>
              <p className="text-lg font-semibold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
                Куда хотите пойти?
              </p>
              <p className="text-sm text-[var(--text-secondary)] mt-1.5">
                Название места, вулкана или перевала — ниже появятся пути к нему.
              </p>
            </div>

            <div className="w-full">
              {renderDestinationPicker()}
            </div>

            <div className="text-xs text-[var(--text-muted)] space-y-1.5 text-center" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.7)' }}>
              <p>Карты можно скачать заранее — в поле они работают без сети.</p>
              <p>Компас появится, если у телефона есть датчик.</p>
            </div>

            {/* Наблюдение/место/трек не требуют выбранной цели — эти
                действия route-независимы (координаты берёт GPS телефона).
                Раньше панель жила только в ветке «маршрут выбран», и ссылка
                с главной «Сообщить о наблюдении с экрана маршрута» приводила
                на пустой экран выбора маршрута вместо формы (владелец 27.08:
                «стала открывать маршрут вместо своей формы»). */}
            <div className="w-full pt-2 border-t border-[var(--border)]">
              <p className="text-xs text-[var(--text-muted)] mb-2 pt-3">Цель не нужна, чтобы сообщить о находке:</p>
              <FieldActionBar actions={fieldActions} error={fieldBarError} />
            </div>
          </div>
        ) : (
        <>

        {/* Компас переехал в плавающий инструмент над картой (редизайн
            29.08, Шаг 3) — см. рендер сразу после плашки статуса выше.
            CSS order-хак («при мёртвом фиксе компас поднимается наверх»,
            решение владельца 21.08) снят: он был нужен, только пока компас
            и геройская цифра делили одно место в столбце. Теперь у компаса
            своё постоянное место, всегда на виду — деградация ступени III
            больше не требует его СМЕЩЕНИЯ, только собственная честность
            прибора (гаснущее кольцо, нет стрелки) осталась в FieldCompass
            без изменений. */}
        {/* Геройская цифра — НЕПРОЗРАЧНАЯ карточка, не текст на карте
            (правка 29.08 по живому скрину владельца: text-shadow поверх
            реального трека читался плохо, линия шла прямо сквозь цифры —
            «кринж»). Это не отступление от контракта §2, а прямое
            следование ему: «критичные приборы и действия — ...главная
            цифра навигации... — всегда непрозрачные». Не вложенная
            карточка — это первая и единственная видимая граница в этом
            блоке контента. */}
        <div className="flex flex-col items-center gap-4 w-full rounded-2xl p-4"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="text-center w-full">
            {isLoadingRoute ? (
              <div className="flex flex-col gap-2.5">
                <div className="h-3 w-32 rounded-full animate-pulse" style={{ background: 'var(--bg-card)' }} />
                <div className="h-10 w-24 rounded-lg animate-pulse" style={{ background: 'var(--bg-card)' }} />
                <div className="h-3 w-20 rounded-full animate-pulse" style={{ background: 'var(--bg-card)' }} />
              </div>
            ) : waypoints.length > 0 ? (
              <>
                {/* Название маршрута и счёт точек живут в приборной строке
                    сверху (макет FCN). Дублировать их рядом с главной цифрой
                    значит заставить их спорить с ней за внимание; счётчик
                    порядка при одной точке не печатается вовсе — «1 из 1»
                    рядом с «18.5 км» читалось как «вы пришли, идти ещё 18
                    километров» (скрин владельца 10.08). */}
                {approach?.dataConflict ? (
                  /* Данные маршрута не сходятся: точка из route_waypoints и
                     линия из geometry описывают разное. Мы не знаем даже, как
                     туда добираются — по воде, по другой дороге или никак.
                     Цифра тут была бы уверенностью на пустом месте. */
                  <div className="max-w-[240px]">
                    <p className="text-sm font-semibold text-[var(--warning)] mb-1">
                      Данные маршрута не сходятся
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] leading-snug">
                      Точка стоит в {fmtKm(approach.exitKm)} от трека. Как туда идут — по этим
                      данным неизвестно, поэтому расстояние и время не показываем.
                      Карта, компас и СОС работают.
                    </p>
                  </div>
                ) : distLabel === null ? (
                  /* Расстояние считается от НАШЕГО положения, и без фикса его
                     просто нет. Прочерк в шрифте заголовка выглядел серой
                     полосой — читалось как поломка (скрин владельца 09.08).
                     Честнее сказать словами, чего ждём. */
                  <p className="text-sm text-[var(--text-secondary)] mb-1 max-w-[220px]">
                    Ждём сигнал GPS — расстояние и время появятся сами.
                  </p>
                ) : (
                  <>
                    {/* Главная цифра поля. Мёртвый фикс её не стирает — это
                        последнее, что человек знает о своём положении, — но и
                        не выдаёт за текущую: цвет уходит в приглушённый.
                        Имя точки, время и набор высоты идут чипами рядом,
                        и только те, что есть в данных. */}
                    <FieldDistance
                      distanceLabel={distLabel}
                      live={figuresLive}
                      caption={waypoints.length > 1 ? 'до следующей точки' : 'до точки'}
                      pointName={nextWp?.name && nextWp.name !== activeRouteTitle ? nextWp.name : null}
                      etaLabel={eta.hours !== null ? `~${formatEta(eta.hours)}` : null}
                      ascentLabel={ahead?.ascentM ? `+${Math.round(ahead.ascentM)} м` : null}
                    />
                    {/* Из чего сложилось число. Подход и выход — прямые, и
                        выдавать их за путь по тропе нельзя: на камчатском
                        рельефе прямая проходит через каньон и реку. */}
                    <p className="text-[11px] text-[var(--text-muted)] leading-tight">
                      {approach
                        ? [
                            approach.userOffTrack ? `${fmtKm(approach.approachKm)} до линии` : null,
                            /* Слово «тропа» заслуживает только снятый трек.
                               У полутора сотен маршрутов geometry — прямые
                               между точками (миграция 168), и «12 км по
                               тропе» там означает длину прямой. Это та же
                               прямая через залив, из-за которой писался
                               #1119, только этажом выше: не в подписи, а
                               ВНУТРИ числа, которое зовётся путём. */
                            `${fmtKm(approach.alongTrackKm)} ${
                              lineFidelity === 'surveyed' ? 'по тропе' : 'по ломаной между точками'
                            }`,
                            approach.targetOffTrack ? `${fmtKm(approach.exitKm)} от линии до точки` : null,
                          ].filter(Boolean).join(' · ')
                        : 'по прямой'}
                      {fix.accuracyM != null && figuresLive ? ` · ±${Math.round(fix.accuracyM)} м` : ''}
                    </p>
                    {approach?.targetOffTrack && (
                      /* Расхождение данных, а не рельефа: линия рисуется по
                         geometry маршрута, а точка приходит из route_waypoints.
                         Промолчать значило бы показать на карте одно, а в
                         числе другое — ровно то, что владелец увидел в поле. */
                      <p className="text-[11px] text-[var(--warning)] leading-tight mt-0.5">
                        Точка стоит в стороне от трека
                      </p>
                    )}
                  </>
                )}

                {/* Слой хода: когда придём. Одна цифра «осталось» не отвечает
                    на вопрос поля (владелец 09.08). Без расстояния считать
                    нечего — тогда и строк нет: «придём через —» это не
                    сдержанность, а вид поломки. Прогресс «пройдено/осталось»
                    вынесен в полноширинный модуль ниже (макет FCN). */}
                {/* Время в пути показано чипом у главной цифры; здесь
                    остаётся только оговорка о том, ОТКУДА оно взялось —
                    без неё «~32 мин» выглядит измерением, а не оценкой. */}
                {distLabel !== null && etaNote && (
                  <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>{etaNote}</p>
                )}

                {/* Режим движения: пеший ETA на 30-километровом плече-переезде
                    абсурден, поэтому спрашиваем прямо, а не угадываем. */}
                <div className="mt-3 inline-flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  {([['foot', 'Пешком'], ['car', 'На машине']] as const).map(([m, label]) => (
                    <button key={m} onClick={() => changeTravelMode(m)}
                      aria-pressed={travelMode === m}
                      className="text-xs font-medium px-3 py-1.5"
                      style={travelMode === m
                        ? { background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success)' }
                        : { color: 'var(--text-muted)' }}>
                      {label}
                    </button>
                  ))}
                </div>
                <button onClick={openRouteModal}
                  className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg mt-3"
                  style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)', color: 'var(--success)', border: '1px solid color-mix(in srgb, var(--success) 20%, transparent)' }}>
                  Сменить маршрут <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </>
            ) : activeRouteTitle ? (
              <>
                <p className="text-[var(--success)] text-xs font-medium mb-0.5 truncate max-w-[200px]">{activeRouteTitle}</p>
                <p className="text-[var(--text-muted)] text-xs mb-2">GPS-трек недоступен</p>
                <button onClick={openRouteModal}
                  className="inline-flex items-center gap-1 text-sm font-medium px-3 py-1.5 rounded-lg"
                  style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)', color: 'var(--success)', border: '1px solid color-mix(in srgb, var(--success) 20%, transparent)' }}>
                  Сменить маршрут <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <>
                <p className="text-[var(--text-muted)] text-sm mb-2">нет активного маршрута</p>
                <button onClick={openRouteModal}
                  className="inline-flex items-center gap-1 text-sm font-medium px-3 py-1.5 rounded-lg"
                  style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)', color: 'var(--success)', border: '1px solid color-mix(in srgb, var(--success) 20%, transparent)' }}>
                  Выбрать маршрут <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Панель полевых действий (владелец 27.08): место · трек ·
            наблюдение — при карточке следующей точки, одно касание — одно
            действие. SOS сюда не входит: он отдельным красным действием в
            сетке ниже, красный цвет — только тревога (§7). */}
        <div className="w-full">
          <FieldActionBar actions={fieldActions} error={fieldBarError} />
        </div>

        {/* Восстановление: когда реальность разошлась с планом, главной
            задачей становится она — но приборы остаются на месте, карточка
            стоит НИЖЕ компаса и дистанции и ничего не закрывает. */}
        {hasRoute && recovery.kind !== 'none' && (
          <RecoveryCard
            state={recovery}
            muted={mutedRecovery === recovery.kind}
            onMute={() => setMutedRecovery(recovery.kind)}
            onUnmute={() => setMutedRecovery(null)}
            onPrimary={kind => {
              if (kind === 'open_map') {
                setMapCenter(coords ? [coords.lat, coords.lng] : (waypoints[0] ? [waypoints[0].lat, waypoints[0].lng] : undefined));
                setShowMap(true);
              } else if (kind === 'open_pack') {
                const id = crumbsRouteRef.current;
                if (id) void saveMap(id);
              } else if (kind === 'open_conditions') {
                openConditions();
              }
            }}
          />
        )}

        {/* Прогресс по маршруту — постоянный второй слой под главной задачей
            (макет FCN): компас отвечает «куда сейчас», этот блок — «сколько
            сделано». При конфликте данных прогресса нет вовсе: считать общий
            путь из противоречивых линии и точек нельзя. */}
        {waypoints.length > 0 && !approach?.dataConflict && (
          <RouteProgressBar
            doneKm={progress.doneKm}
            totalKm={progress.totalKm}
            percent={progress.percent}
            fidelity={lineFidelity}
            live={figuresLive}
            staleLabel={!figuresLive ? fixLabel(fix) : null}
            checkpoint={waypoints.length > 1
              ? { current: Math.min(currentWpIdx + 1, waypoints.length), total: waypoints.length }
              : null}
          />
        )}

        {/* Коридор: что за следующей точкой (финал полевого экрана, «го»
            21.08). Только из route_waypoints — выдуманных бродов здесь нет;
            точек впереди нет — блока нет. */}
        {corridorItems.length > 0 && !approach?.dataConflict && (
          <FieldCorridor items={corridorItems} />
        )}

        {/* Приборы показываем, только когда им есть что показать: «— м» и
            «0ч 00м» читаются не как «данных нет», а как «сломалось». */}
        {figuresLive && (
        <div className={`grid gap-3 w-full ${altitude !== null ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {/* Высоту даёт не всякий приёмник: на многих телефонах и почти всегда
              при позиционировании по Wi-Fi coords.altitude приходит null. Карточка
              с «— м» крупным жирным шрифтом читается как поломка прибора, а не
              как «этот телефон высоту не отдаёт» — поэтому её просто нет, а
              соседняя занимает всю ширину. Стрелки вверх тоже нет: высота здесь
              абсолютная, а стрелка обещает набор, которого мы не считаем. */}
          {altitude !== null && (
            <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <p className="text-[var(--text-muted)] text-xs uppercase tracking-wide mb-1">Высота</p>
              <p className="text-2xl font-bold text-[var(--text-primary)]">{altitude.toLocaleString('ru')} м</p>
            </div>
          )}
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <p className="text-[var(--text-muted)] text-xs uppercase tracking-wide mb-1">Время в пути</p>
            <p className="text-2xl font-bold text-[var(--text-primary)]">
              {hours}ч {mins.toString().padStart(2, '0')}м
            </p>
          </div>
        </div>
        )}

        {/* Профиль высоты впереди — если высоты в данных есть. Иначе ниже
            идёт СХЕМА ТОЧЕК, и она подписана схемой: прежний график рисовал
            широту по вертикали и на маршруте с севера на юг выглядел ровным
            спуском — рельеф, которого нет (аудит 09.08). */}
        {ahead && (
          <div className="w-full">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[var(--text-muted)] text-xs uppercase tracking-wide">
                Профиль впереди
                {relief?.source && (
                  <span className="normal-case tracking-normal"> · по модели рельефа</span>
                )}
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                <span className="text-[var(--accent)]">↑ {ahead.ascentM} м</span>
                {' · '}
                <span className="text-[var(--ocean)]">↓ {ahead.descentM} м</span>
              </p>
            </div>
            <div className="w-full h-24 rounded-xl overflow-hidden"
              style={{
                background: 'color-mix(in srgb, var(--success) 6%, var(--bg-card))',
                border: '1px solid var(--border)',
              }}>
              <svg className="w-full h-full" viewBox="0 0 320 96" preserveAspectRatio="none">
                {(() => {
                  const pts = ahead.points;
                  const maxD = pts[pts.length - 1].dM || 1;
                  const zs = pts.map(p => p.zM);
                  const minZ = Math.min(...zs);
                  const range = Math.max(1, Math.max(...zs) - minZ);
                  const xy = pts.map(p => ({
                    x: (p.dM / maxD) * 320,
                    y: 88 - ((p.zM - minZ) / range) * 76,
                  }));
                  const line = xy.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
                  return (
                    <>
                      <polyline points={`0,96 ${line} 320,96`} fill="rgba(74,222,128,0.12)" stroke="none" />
                      <polyline points={line} fill="none" stroke="var(--success)" strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round" />
                      {/* «Вы здесь» — начало отрезка, а не абстрактный ноль. */}
                      <circle cx={xy[0].x} cy={xy[0].y} r="5" fill="var(--accent)" />
                    </>
                  );
                })()}
              </svg>
            </div>
          </div>
        )}

        {/* Схема маршрута */}
        <div className="w-full">
          <p className="text-[var(--text-muted)] text-xs uppercase tracking-wide mb-1.5">
            {/* Подпись говорит, что это на самом деле: вид сверху, а не
                профиль высоты. Профиль живёт выше и только на реальных
                высотах. Формулировка человеческая — прежняя была голосом
                разработчика (владелец 09.08). */}
            {sketch?.fromTrack ? 'Трек маршрута, вид сверху' : 'Точки маршрута'}
          </p>
          {/* Чем является линия. Пунктир и приглушённый цвет читаются не
              всеми и не на солнце; на экране, по которому идут, происхождение
              нужно сказать словами. Для снятого трека подписи нет — молчание
              здесь и означает «это настоящий трек». */}
          {trackFidelityLabel(lineFidelity) && (
            <p className="text-[11px] leading-snug mb-1.5" style={{ color: 'var(--warning)' }}>
              {trackFidelityLabel(lineFidelity)}
            </p>
          )}
          <div className="w-full h-32 rounded-xl overflow-hidden"
            style={{
              background: 'color-mix(in srgb, var(--success) 6%, var(--bg-card))',
              border: '1px solid var(--border)',
            }}>
          {svgPoints ? (
            /* preserveAspectRatio по умолчанию (meet): очертания не тянутся.
               Сетку убрали — она превращала карту в график, хотя это план
               местности, а не диаграмма. */
            <svg className="w-full h-full" viewBox="0 0 320 128">
              <polyline
                points={svgPoints.map(p => `${p.x},${p.y}`).join(' ')}
                fill="none" stroke="var(--success)" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"
              />
              {sketch?.me && (
                <>
                  <circle cx={sketch.me.x} cy={sketch.me.y} r="7" fill="var(--ocean)" opacity="0.25" />
                  <circle cx={sketch.me.x} cy={sketch.me.y} r="3.5" fill="var(--ocean)" />
                </>
              )}
              {(sketch?.dots ?? []).map(({ x, y, i }) => (
                <circle key={i} cx={x} cy={y}
                  r={i === currentWpIdx ? 5 : 3}
                  fill={i < currentWpIdx ? 'var(--success)' : i === currentWpIdx ? 'var(--accent)' : 'var(--text-muted)'}
                  stroke={i === currentWpIdx ? 'var(--accent)' : 'none'}
                  strokeWidth="2"
                />
              ))}
            </svg>
          ) : (
            <div className="flex items-center justify-center h-full text-[var(--text-secondary)] text-xs">
              {isLoadingRoute
                ? 'Загрузка трека…'
                : activeRouteTitle
                  // Маршрут выбран — значит виноват не выбор, а данные.
                  ? 'У маршрута нет трека в данных'
                  : 'Выберите маршрут для отображения трека'}
            </div>
          )}
          </div>
        </div>
        </>
        )}

      </div>

      {/* Офлайн-контур не поднялся — сказать до выхода, а не оставить
          выяснять в поле. Раньше отказ регистрации SW глотался молча, и
          «Сохранить карту» выглядело работающим, ничего не сохраняя. */}
      {hasRoute && (swReg.state === 'failed' || swReg.state === 'unsupported') && (
        <div className="px-4 py-3 text-xs" style={{ color: 'var(--warning)', borderTop: '1px solid var(--border)' }}>
          {swReg.state === 'unsupported'
            ? 'Браузер не поддерживает офлайн-режим: карта не сохранится, очередь SOS без связи не сработает'
            : 'Офлайн-режим не запустился в этом сеансе: карта не сохранится. Перезагрузите страницу, пока есть связь'}
        </div>
      )}

      {/* Карта офлайн: три состояния — качается, сохранена, не сохранена.
          Раньше строка появлялась только на время фоновой докачки, а
          проверить готовность было нечем: единственный момент, когда это
          выясняется, наступал уже без связи. */}
      {hasRoute && (tileDl || savedMap || mapPlan) && (
        <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)', borderTop: '1px solid #21262d' }}>
          {tileDl && tileDl.total > 0 ? (
            <div className="flex items-center gap-2">
              <Download className="w-3.5 h-3.5 animate-pulse" style={{ color: 'var(--success)' }} />
              Сохраняем карту: {tileDl.done} / {tileDl.total}
              <span className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: '#21262d' }}>
                <span className="block h-full rounded-full"
                  style={{ width: `${Math.round((tileDl.done / tileDl.total) * 100)}%`, background: 'var(--success)' }} />
              </span>
            </div>
          ) : savedMap ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Check className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} />
              <span style={{ color: 'var(--text-secondary)' }}>
                Карта сохранена · {savedMapSummary(savedMap)}
              </span>
              {mapPlan && (
                <button onClick={() => { const id = crumbsRouteRef.current; if (id) void saveMap(id); }}
                  className="underline underline-offset-2" style={{ color: 'var(--ocean)' }}>
                  Обновить
                </button>
              )}
              {/* Отброшенные зумы и незакреплённое хранилище — то, из-за чего
                  «сохранено» может не совпасть с тем, что человек ждёт. */}
              {savedMap.droppedZooms.length > 0 && (
                <span className="w-full" style={{ color: 'var(--warning)' }}>
                  Детальные слои не поместились — вблизи карта грубее
                </span>
              )}
              {!savedMap.persisted && (
                <span className="w-full" style={{ color: 'var(--warning)' }}>
                  Система может удалить карту при нехватке места на телефоне
                </span>
              )}
              {/* Убрать пакет было НЕЛЬЗЯ до 22.08.2026: манифест снимался
                  только вручную из кода, а тайлы коридора оставались навсегда.
                  При переполнении хранилища браузер выбрасывает всё разом —
                  то есть чужой залежавшийся пакет отнимает карту у того, кто
                  собрался в поход завтра. */}
              <button
                type="button"
                onClick={() => { const id = crumbsRouteRef.current; if (id) void dropPack(id); }}
                disabled={dropping}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg disabled:opacity-60"
                style={{
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {dropping ? 'Убираю' : 'Убрать пакет'}
              </button>
              {dropNote && (
                <span className="w-full" style={{ color: 'var(--warning)' }}>{dropNote}</span>
              )}
            </div>
          ) : mapPlan ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button onClick={() => { const id = crumbsRouteRef.current; if (id) void saveMap(id); }}
                className="inline-flex items-center gap-1.5 font-semibold px-3 py-1.5 rounded-lg"
                style={{
                  background: 'color-mix(in srgb, var(--success) 10%, transparent)',
                  color: 'var(--success)',
                  border: '1px solid color-mix(in srgb, var(--success) 20%, transparent)',
                }}>
                <Download className="w-3.5 h-3.5" />
                {/* Ноль на кнопке — не размер, а его отсутствие, и читается он
                    как «бесплатно». Если веса нет, честнее не называть числа:
                    сервер режет квадрат по 2000 тайлов, за кнопкой стоят
                    десятки мегабайт мобильного трафика (скрин владельца 10.08).
                    Пакет — один шаг: карта, линия, точки и снимок условий
                    сохраняются этой же кнопкой (FCN этап 2). */}
                {mapPlan.mb > 0 ? `Сохранить полевой пакет · ${mapPlan.mb} МБ` : 'Сохранить полевой пакет'}
              </button>
              <span>
                {mapPlan.coverage === 'corridor' && mapPlan.bufferKm
                  ? `полоса ${mapPlan.bufferKm} км вдоль маршрута`
                  : 'квадрат вокруг места'}
              </span>
              {saveMapError && (
                <span className="w-full" style={{ color: 'var(--warning)' }}>{saveMapError}</span>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* Карточка доверия: род линии + состояние пакета + качество фикса
          одной строкой с раскрытием. partial никогда не зелёный; отсутствие
          линии у points_only — природа маршрута, не дефект пакета. */}
      {hasRoute && (
        <div className="px-4 pb-2">
          <TrustCard
            fidelity={lineFidelity}
            geometrySource={geometrySource}
            hasTrack={!!track && track.length >= 2}
            conflict={approach?.dataConflict === true}
            packStates={packStates}
            packReadiness={packStates ? fieldPackReadiness(packStates) : null}
            fixLabel={fixLabel(fix)}
          />
        </div>
      )}

      {/* Дорогу до точки строит настоящий навигатор.
          Слово владельца 11.08: «смысл людям пользоваться нашей кривой, если
          есть другие». Наш роутер на пробе того же вечера отвечал «пути нет»
          на четыре километра по городу, а Organic Maps ведёт до Маячного за
          27 км. Спорить не с чем: дорога — не наша задача, наша начинается
          там, где их маршрут кончается. Особенно это нужно там, где данные
          маршрута не сходятся и мы честно сняли своё число: человеку всё
          равно надо туда попасть. */}
      {nextWp && (
        <div className="px-4 pb-2">
          <NavigateTo
            to={{ lat: nextWp.lat, lng: nextWp.lng, name: nextWp.name ?? activeRouteTitle ?? 'Точка маршрута' }}
            from={coords ? { lat: coords.lat, lng: coords.lng, name: 'Я' } : null}
            mode="car"
            title="Проложить дорогу до точки"
          />
        </div>
      )}

      {/* Bottom action grid — .fx-glass-dense поверх карты (редизайн 29.08),
          кроме SOS: критичное действие остаётся непрозрачным по контракту §2
          CLAUDE.md («стекло — для контекста, непрозрачность — для действия»)
          и по своей же охране внутри EmergencyAction («критичное действие
          стеклом не делаем»). Три остальные — контекстные переходы, им
          стекло положено; fx-glass-dense уже несёт фолбэк на
          prefers-reduced-transparency и @supports (globals.css). */}
      <div className="grid grid-cols-2 gap-2 p-4">
        <button onClick={() => {
            setMapCenter(coords ? [coords.lat, coords.lng] : (waypoints[0] ? [waypoints[0].lat, waypoints[0].lng] : undefined));
            setShowMap(true);
          }}
          className="fx-glass-dense flex items-center justify-center gap-2 rounded-2xl font-bold text-sm"
          style={{ color: 'var(--success)', minHeight: 60 }}>
          <MapIcon className="w-5 h-5" /> КАРТА
        </button>
        {/* Условия — внутренний снимок из пакета, не внешняя ссылка:
            OpenWeatherMap в поле без сети — мёртвая кнопка, а решение
            «идти или нет» принимается по нашему safety-слою (план FCN:
            в active mode нет внешних переходов). */}
        <button onClick={openConditions}
          className="fx-glass-dense flex items-center justify-center gap-2 rounded-2xl font-bold text-sm"
          style={{ color: 'var(--ocean)', minHeight: 60 }}>
          <CloudSun className="w-5 h-5" /> УСЛОВИЯ
        </button>
        {/* «Группа» вместо AI-чата: в активном режиме нет длинного разговора,
            есть план и контакт вне маршрута (макеты FCN, решение владельца).
            Кузьмич остаётся в шапке и на других экранах. */}
        <button onClick={() => setShowGroup(true)}
          className="fx-glass-dense flex items-center justify-center gap-2 rounded-2xl font-bold text-sm"
          style={{ color: 'var(--accent)', minHeight: 60 }}>
          <Users className="w-5 h-5" /> ГРУППА
        </button>
        {/* SOS — общий компонент, не своя кнопка: здесь жил сырой tel:112
            без офлайн-ветки. Копии SOS уже расходились поведением (#887),
            и полевой экран — последнее место, где это допустимо. */}
        <EmergencyAction variant="field" />
      </div>
      </div>
      {/* Конец bottom sheet — см. открывающий div с комментарием выше. */}

      {/* Условия: снимок из полевого пакета (работает без сети) + живой
          статус при связи. «Мы не знаем» никогда не выглядит как «спокойно». */}
      {showConditions && (() => {
        const snap = liveSafety ?? (pack?.safety && !pack.safety.unavailable ? pack.safety : null);
        return (
          <div className="fixed inset-0 z-50 flex flex-col justify-end" style={{ background: 'rgba(0,0,0,0.7)' }}
            onClick={() => setShowConditions(false)}>
            <div className="rounded-t-2xl p-4 pb-6" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-[var(--text-primary)] text-base">Условия</h3>
                <button onClick={() => setShowConditions(false)}
                  className="p-1.5 rounded-lg" style={{ background: 'var(--bg-card)' }} aria-label="Закрыть">
                  <X className="w-4 h-4 text-[var(--text-muted)]" />
                </button>
              </div>
              {snap ? (
                <div className="space-y-2 text-sm">
                  <p style={{ color: snap.hasAlert ? 'var(--warning)' : 'var(--text-primary)' }} className="font-semibold">
                    {snap.hasAlert
                      ? (snap.topTitle ?? `Активные предупреждения (тяжесть ${snap.maxSeverity} из 5)`)
                      : 'Активных предупреждений по краю нет'}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {liveSafety ? 'Живой статус' : 'Снимок из полевого пакета'} · {formatSnapshotAge(snap.at)}
                    {snap.source ? ` · ${snap.source}` : ''}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Это обстановка по краю целиком, а не оценка вашего маршрута.
                    Экстренный телефон — 112.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 text-sm">
                  <p className="font-semibold" style={{ color: 'var(--warning)' }}>
                    Данных об обстановке сейчас нет
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Это не означает, что опасности нет: снимок условий не был сохранён
                    в полевой пакет, а связи для живого статуса нет. Экстренный телефон — 112.
                  </p>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Группа: состояние брифинга и экстренная связь. Работает офлайн —
          сеть здесь не нужна: мы не показываем чужих положений и не
          обещаем слежения, только то, что человек подготовил до выхода. */}
      {showGroup && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setShowGroup(false)}>
          <div className="rounded-t-2xl p-4 pb-6" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-[var(--text-primary)] text-base">Группа</h3>
              <button onClick={() => setShowGroup(false)}
                className="p-1.5 rounded-lg" style={{ background: 'var(--bg-card)' }} aria-label="Закрыть">
                <X className="w-4 h-4 text-[var(--text-muted)]" />
              </button>
            </div>
            <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              Брифинг — ссылка контакту вне маршрута: план и время возврата.
              Положение по ней не передаётся: платформа его не знает и слежения не обещает.
            </p>
            {crumbsRouteRef.current && (
              <Link href={`/routes/${crumbsRouteRef.current}/prepare`}
                className="flex items-center justify-between gap-2 px-3 py-3 rounded-xl text-sm font-semibold mb-2"
                style={{
                  background: 'color-mix(in srgb, var(--success) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)',
                  color: 'var(--success)',
                }}>
                Открыть план и отправить брифинг
                <ChevronRight className="w-4 h-4 shrink-0" />
              </Link>
            )}
            <EmergencyAction
              className="flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-bold"
              style={{ background: 'var(--danger)', color: '#fff' }}>
              <Phone className="w-4 h-4" /> 112 — экстренный вызов
            </EmergencyAction>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              Диспетчеру нужны: название маршрута, ваше положение и время выхода.
            </p>
          </div>
        </div>
      )}

      </div>
      {/* Конец приборного столбца (см. открывающий div с z-10 у карты выше). */}

      {/* Режим «Карта» (кнопка «Карта» / RecoveryCard.open_map) — та же
          постоянная карта выше, без второго инстанса LeafletMap: он не
          дешёвый (тайлы + кластер), два одновременно — реальная просадка на
          телефоне в поле. Здесь только фокус-режим: приборный столбец скрыт
          (класс hidden у z-10-обёртки), остаются только кнопка закрытия,
          пустая-карта подсказка и панель действий — поверх той же карты. */}
      {showMap && (
        <div className="fixed inset-0 z-20 pointer-events-none">
          <button onClick={() => setShowMap(false)}
            className="pointer-events-auto absolute top-4 left-4 w-11 h-11 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(13,17,23,0.85)', color: '#fff', border: '1px solid #30363d' }}
            aria-label="Закрыть карту">
            <X className="w-5 h-5" />
          </button>
          {mapMarkers.length === 0 && (
            <div className="absolute bottom-32 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm whitespace-nowrap"
              style={{ background: 'rgba(13,17,23,0.9)', color: 'var(--text-muted)', border: '1px solid #30363d' }}>
              Маршрут не выбран — карта без трека
            </div>
          )}
          {/* Карта — рабочая поверхность (мокап владельца): та же панель
              полевых действий, что на приборном экране, — не копия, тот же
              fieldActions. Наблюдение с карты открывает ту же шторку. */}
          <div className="pointer-events-auto absolute inset-x-0 bottom-0 px-4"
            style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
            <FieldActionBar actions={fieldActions} error={fieldBarError} />
          </div>
        </div>
      )}

      {/* Навигаторный выбор маршрута: место → варианты → превью на карте → фиксация */}
      {showRouteModal && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => { setShowRouteModal(false); setPreview(null); setSelectedDestination(null); setSelectedOrigin(null); setMapPickMode(null); setPickedCoord(null); }}>
          <div className="rounded-t-2xl p-4 max-h-[85vh] overflow-y-auto"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-[var(--text-primary)] text-base">Куда хотите пойти?</h3>
              <button onClick={() => { setShowRouteModal(false); setPreview(null); setSelectedDestination(null); setSelectedOrigin(null); setMapPickMode(null); setPickedCoord(null); }}
                className="p-1.5 rounded-lg" style={{ background: 'var(--bg-card)' }}>
                <X className="w-4 h-4 text-[var(--text-muted)]" />
              </button>
            </div>

            {renderDestinationPicker()}
          </div>
        </div>
      )}

      {/* Наблюдение: форма поверх экрана, никуда не уводит. Координаты —
          текущий фикс навигатора; нет фикса — уйдёт без привязки, и это
          говорится словами. */}
      <ObservationSheet
        open={obsOpen}
        onClose={() => setObsOpen(false)}
        lat={coords?.lat ?? null}
        lng={coords?.lng ?? null}
      />
    </div>
  );
}

// ─── Планирование tab ─────────────────────────────────────────────────────────

function PlanningTab({ onStartTrail }: { onStartTrail?: (routeId: string) => void }) {
  const [checklist, setChecklist] = useState<ChecklistItem[]>(DEFAULT_CHECKLIST);
  const [routes, setRoutes] = useState<RoutePreview[]>([]);
  const [kuzmichTip, setKuzmichTip] = useState<string | null>(null);
  const emergencyRef = useRef<HTMLDivElement>(null);
  const [showGearModal, setShowGearModal] = useState(false);
  const [gearChecked, setGearChecked] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('gear_checked') ?? '[]') as string[]); }
    catch { return new Set(); }
  });

  // Reactive checklist state
  const { status: mapsStatus, progress: mapsProgress, error: mapsError, regionMeta, download: downloadMaps } = useOfflineRegion('avacha-group');
  const [hasActiveRoute, setHasActiveRoute] = useState(false);
  /**
   * Свидетельство, что карта этого маршрута ДЕЙСТВИТЕЛЬНО лежит в телефоне.
   *
   * Галочка «Маршрут сохранён офлайн» ставилась от `hasActiveRoute` — то есть
   * от того, что маршрут выбран. Ни одного скачанного байта за ней не стояло,
   * а человек уходил в поле, отметив себе, что всё взято.
   */
  const [savedRouteMap, setSavedRouteMap] = useState<SavedMapRecord | null>(null);

  useEffect(() => {
    const routeId = localStorage.getItem('active_trail_route_id');
    setHasActiveRoute(!!routeId);
    if (!routeId) { setSavedRouteMap(null); return; }
    try {
      setSavedRouteMap(parseSavedMap(localStorage.getItem(savedMapKey(routeId))));
    } catch { setSavedRouteMap(null); }
  }, []);

  // Override 'done' for auto-computed items
  const effectiveChecklist = checklist.map(item => {
    if (item.id === 'maps') {
      // Вес — из настоящей записи о скачанном регионе. В подписи стояло
      // «450 МБ» константой: число, которое никто не мерил, на чек-листе
      // готовности к выходу.
      const mb = regionMeta ? Math.max(1, Math.round(regionMeta.sizeBytes / 1024 / 1024)) : null;
      return {
        ...item,
        done: mapsStatus === 'cached',
        label: mb ? `Карты региона скачаны · ${mb} МБ` : 'Карты региона скачаны',
      };
    }
    // «Маршрут сохранён офлайн» отмечался от того, что маршрут ВЫБРАН
    // (`hasActiveRoute`). То есть галочка про готовность к отсутствию связи
    // ставилась сама, без единого скачанного байта, — и человек уходил в
    // поле, отметив себе, что всё взято. Настоящее свидетельство одно:
    // запись о завершённой закачке карты этого маршрута.
    if (item.id === 'offline') return { ...item, done: savedRouteMap !== null };
    if (item.id === 'gear') return { ...item, done: gearChecked.size === GEAR_LIST.length };
    return item;
  });

  useEffect(() => {
    // Load checklist from localStorage (only manually-toggled items)
    try {
      const raw = localStorage.getItem('trip_checklist');
      if (raw) setChecklist(JSON.parse(raw) as ChecklistItem[]);
    } catch { /* ignore */ }

    // Load Kuzmich tip
    fetch('/api/public/safety-status')
      .then(r => r.json())
      .then((d: unknown) => {
        if (
          typeof d === 'object' && d !== null &&
          'topTitle' in d && typeof (d as Record<string, unknown>).topTitle === 'string'
        ) {
          setKuzmichTip((d as Record<string, unknown>).topTitle as string);
        }
      })
      .catch(() => {});

    // Load popular routes
    fetch('/api/routes?limit=8&sort=recommended&kind=route')
      .then(r => r.json())
      .then((d: unknown) => {
        if (
          typeof d === 'object' && d !== null && 'success' in d &&
          (d as Record<string, unknown>).success === true &&
          Array.isArray((d as Record<string, unknown>).data)
        ) {
          const items = ((d as Record<string, unknown>).data as unknown[]).slice(0, 8).map(r => {
            if (typeof r !== 'object' || r === null) return null;
            const row = r as Record<string, unknown>;
            return {
              id: row.id as string,
              title: row.title as string,
              difficulty: (row.difficulty as string | null) ?? null,
              durationDays: row.durationDays != null ? Number(row.durationDays) : null,
              distanceKm: row.distanceKm != null ? Number(row.distanceKm) : null,
              imageUrl: null,
            } satisfies RoutePreview;
          }).filter(Boolean) as RoutePreview[];
          setRoutes(items);
        }
      })
      .catch(() => {});
  }, []);

  function toggleItem(id: string) {
    // 'offline' can't be manually toggled — it's auto-computed
    if (id === 'offline') return;
    // maps — trigger download if not started yet (partial — добрать недостающее)
    if (id === 'maps') {
      if (mapsStatus === 'idle' || mapsStatus === 'error' || mapsStatus === 'partial') downloadMaps();
      return;
    }
    // mchs opens a form URL
    if (id === 'mchs') {
      window.open(MCHS_ONLINE_FORM_URL, '_blank', 'noopener,noreferrer');
      return;
    }
    // emergency scrolls to the section
    if (id === 'emergency') {
      emergencyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // gear opens the checklist modal
    if (id === 'gear') {
      setShowGearModal(true);
      return;
    }
    setChecklist(prev => {
      const next = prev.map(item => item.id === id ? { ...item, done: !item.done } : item);
      try { localStorage.setItem('trip_checklist', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function toggleGearItem(id: string) {
    setGearChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('gear_checked', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }

  const doneCount = effectiveChecklist.filter(i => i.done).length;

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 pb-32 space-y-6">
      {/* Kuzmich recommendation banner */}
      <div className="rounded-lg overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <div className="relative h-40 bg-[var(--bg-hover)]">
          <Image
            src="/images/hero/bears-kurilskoye.jpg"
            alt="Камчатка"
            fill
            sizes="(max-width: 640px) 100vw, 600px"
            className="object-cover"
          />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, transparent 30%, rgba(0,0,0,0.75))' }} />
          <div className="absolute bottom-0 left-0 right-0 p-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full overflow-hidden shrink-0 bg-[var(--accent)] flex items-center justify-center"
                style={{ border: '2px solid rgba(255,255,255,0.6)' }}>
                <Bot size={18} strokeWidth={1.5} className="text-white" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-white/60 mb-0.5">Кузьмич рекомендует:</p>
                <p className="text-sm font-medium text-white leading-snug">
                  {kuzmichTip ?? 'Планируйте маршрут заранее и проверьте готовность'}
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="p-4">
          {/* AI-конструктор маршрута (граф зон, живая доступность, погода,
              safety-гейты) — не /ai-assistant, это отдельный, более мощный движок */}
          <Link href="/planner"
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl font-semibold text-sm text-white transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent)' }}>
            Собрать маршрут <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {/* Checklist */}
      <div className="rounded-lg p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-4 mb-5">
          <ProgressRing done={doneCount} total={effectiveChecklist.length} />
          <div>
            <h2 className="font-bold text-[var(--text-primary)]">Готовность к походу</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {doneCount === effectiveChecklist.length ? 'Всё готово! Удачного похода.' : `Выполнено ${doneCount} из ${effectiveChecklist.length}`}
            </p>
          </div>
        </div>
        {/* Полный план подготовки — вход в маршрутный экран семи доменов
            (FCN этап 4). Этот чек-лист остаётся быстрой механикой (карты,
            МЧС), доменная модель живёт в одном месте — lib/preparation. */}
        {hasActiveRoute && (() => {
          let rid: string | null = null;
          try { rid = localStorage.getItem('active_trail_route_id'); } catch { /* ssr/приват */ }
          return rid ? (
            <Link href={`/routes/${rid}/prepare`}
              className="flex items-center justify-between gap-2 px-3 py-3 rounded-xl mb-3 text-sm font-semibold"
              style={{
                background: 'color-mix(in srgb, var(--success) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--success) 22%, transparent)',
                color: 'var(--success)',
              }}>
              План подготовки к походу: 7 доменов
              <ChevronRight className="w-4 h-4 shrink-0" />
            </Link>
          ) : null;
        })()}
        <div className="space-y-1">
          {effectiveChecklist.map(item => {
            const isExternal = item.id === 'mchs' || item.id === 'emergency';
            const isDownloading = item.id === 'maps' && (mapsStatus === 'fetching-routes' || mapsStatus === 'caching-tiles');
            const showDownloadIcon = item.id === 'maps' && !item.done && mapsStatus !== 'caching-tiles' && mapsStatus !== 'fetching-routes';
            return (
              <div key={item.id}>
                <button
                  onClick={() => toggleItem(item.id)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-colors hover:bg-[var(--bg-hover)] text-left min-h-[44px]"
                >
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                    item.done
                      ? 'bg-[var(--success)]'
                      : 'border-2 border-[var(--border)]'
                  }`}>
                    {item.done && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                  </div>
                  <span className={`flex-1 text-sm ${item.done ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                    {item.label}
                  </span>
                  {isExternal && !item.done && (
                    <ExternalLink className="w-3.5 h-3.5 text-[var(--ocean)] shrink-0" />
                  )}
                  {showDownloadIcon && (
                    <Download className="w-3.5 h-3.5 text-[var(--ocean)] shrink-0" />
                  )}
                  {isDownloading && (
                    <span className="text-[10px] text-[var(--accent)] font-medium shrink-0">{mapsProgress.percent}%</span>
                  )}
                </button>
                {isDownloading && (
                  <div className="px-4 pb-2">
                    <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                      <div className="h-1 rounded-full transition-all" style={{ background: 'var(--accent)', width: `${mapsProgress.percent}%` }} />
                    </div>
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {mapsStatus === 'fetching-routes' ? 'Подготовка…' : `Скачивание ${mapsProgress.done} / ${mapsProgress.total}`}
                    </p>
                  </div>
                )}
                {item.id === 'maps' && mapsStatus === 'error' && mapsError && (
                  <p className="px-4 pb-2 text-[10px]" style={{ color: 'var(--danger)' }}>
                    Ошибка: {mapsError} — нажми ещё раз
                  </p>
                )}
                {/* Частичный пакет — не готовность: галочки нет, причина словами */}
                {item.id === 'maps' && mapsStatus === 'partial' && (
                  <p className="px-4 pb-2 text-[10px]" style={{ color: 'var(--warning)' }}>
                    Карта скачана не полностью — нажми ещё раз, пока есть связь
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Popular routes */}
      {routes.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-[var(--text-primary)]">Популярные маршруты</h2>
            <Link href="/routes" className="text-sm text-[var(--ocean)] hover:underline flex items-center gap-0.5">
              Все маршруты <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
            {routes.map(route => <RouteCard key={route.id} route={route} onNavigate={onStartTrail} />)}
          </div>
        </div>
      )}

      {/* Gear checklist modal */}
      {showGearModal && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setShowGearModal(false)}>
          <div className="rounded-t-2xl p-4 max-h-[80vh] overflow-y-auto"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-[var(--text-primary)] text-base">Проверка снаряжения</h3>
              <button onClick={() => setShowGearModal(false)}
                className="p-1.5 rounded-lg" style={{ background: 'var(--bg-hover)' }}>
                <X className="w-4 h-4 text-[var(--text-secondary)]" />
              </button>
            </div>
            {Object.entries(
              GEAR_LIST.reduce<Record<string, GearItem[]>>((acc, item) => {
                (acc[item.category] ??= []).push(item);
                return acc;
              }, {})
            ).map(([cat, items]) => (
              <div key={cat} className="mb-4">
                <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>{cat}</p>
                <div className="space-y-1">
                  {items.map(gItem => (
                    <button key={gItem.id} onClick={() => toggleGearItem(gItem.id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors hover:bg-[var(--bg-hover)] text-left">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                        gearChecked.has(gItem.id) ? 'bg-[var(--success)]' : 'border-2 border-[var(--border)]'
                      }`}>
                        {gearChecked.has(gItem.id) && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                      </div>
                      <span className={`text-sm ${gearChecked.has(gItem.id) ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                        {gItem.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button onClick={() => setShowGearModal(false)}
              className="w-full py-3 rounded-xl font-semibold text-sm mt-2 text-white transition-opacity hover:opacity-90"
              style={{ background: 'var(--accent)' }}>
              Готово ({gearChecked.size}/{GEAR_LIST.length})
            </button>
          </div>
        </div>
      )}

      {/* Safety alert shortcut */}
      <div ref={emergencyRef} className="flex items-center gap-3 p-4 rounded-xl"
        style={{ background: 'color-mix(in srgb, var(--danger) 8%, var(--bg-card))', border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)' }}>
        <AlertCircle className="w-5 h-5 shrink-0" style={{ color: 'var(--danger)' }} />
        <div className="flex-1">
          <p className="text-sm font-medium text-[var(--text-primary)]">Экстренная связь</p>
          <p className="text-xs text-[var(--text-secondary)]">Единый номер экстренных служб</p>
        </div>
        <EmergencyAction
          className="text-sm font-bold px-3 py-1.5 rounded-lg text-white"
          style={{ background: 'var(--danger)' }}
          label="112"
        />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function PlanningClient() {
  const [tab, setTab] = useState<string>('planning');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('mode') === 'trail') setTab('trail');
    }
  }, []);

  /**
   * Смена таба обновляет URL. Раньше deep-link был односторонним:
   * ?mode=trail открывал полевой режим, но переключение руками URL не
   * трогало — «поделиться режимом» и перезагрузка возвращали не туда.
   * replaceState, не push: таб — не страница, спамить историю нечем.
   */
  function switchTab(next: 'planning' | 'trail') {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      if (next === 'trail') url.searchParams.set('mode', 'trail');
      else url.searchParams.delete('mode');
      window.history.replaceState(null, '', url.toString());
    } catch { /* URL не обновился — не повод ломать переключение */ }
  }

  function handleStartTrail(routeId: string) {
    try { localStorage.setItem('active_trail_route_id', routeId); } catch { /* ignore */ }
    switchTab('trail');
  }

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {tab === 'planning' && <Header />}

      {/* Tab bar */}
      <div className={`sticky z-40 ${tab === 'planning' ? 'top-[56px]' : 'top-0'}`}
        style={{ background: tab === 'trail' ? 'var(--bg-primary)' : 'var(--bg-card)', borderBottom: `1px solid ${tab === 'trail' ? 'var(--bg-card)' : 'var(--border)'}` }}>
        <div className="max-w-2xl mx-auto px-4 flex gap-0">
          <button
            onClick={() => switchTab('planning')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'planning'
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Navigation className="w-4 h-4" /> Планирование
          </button>
          <button
            onClick={() => switchTab('trail')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'trail'
                ? 'border-[var(--success)] text-[var(--success)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <MapPin className="w-4 h-4" /> На маршруте
          </button>
        </div>
      </div>

      {tab === 'planning' && <PlanningTab onStartTrail={handleStartTrail} />}
      {tab === 'trail' && <OnTrailTab />}
    </div>
  );
}
