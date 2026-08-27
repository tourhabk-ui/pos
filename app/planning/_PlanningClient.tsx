'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import Image from 'next/image';
import {
  Check, ChevronRight, Navigation, MapPin,
  Map as MapIcon, CloudSun, Phone,
  AlertCircle, Wifi, WifiOff, X, ExternalLink, Download, Bot, Users,
  Trash2, Binoculars, MapPinPlus, Square, Route,
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
  readHeading, compassLabel, compassNeedsPermission,
  type CompassState,
} from '@/lib/on-route/fix-quality';
import { remainingRelief, distanceAlongTrack } from '@/lib/routes/relief';
import { connectivityState } from '@/lib/on-route/connectivity';
import {
  trackFidelityLabel, trackFidelityStyle, type TrackFidelity,
} from '@/lib/routes/track-fidelity';
import { addCrumb, parseCrumbs, serializeCrumbs, crumbsKey, type Crumb } from '@/lib/offline/breadcrumbs';
import { connectorLine, CONNECTOR_TITLES, trackLine } from '@/lib/map/line-standard';
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
import { groupRoutesByPlace } from '@/lib/routes/path-choice';

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
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<{
    id: string; title: string; wps: SavedWaypoint[]; grade: PassportGrade | null;
    /** Черта: можно ли обещать ведение. Считается на сервере — см. openPreview. */
    navigability: PreviewNavigability | null;
  } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  /** Отказ по конкретному варианту: показывается у его строки, а не вместо списка. */
  const [previewError, setPreviewError] = useState<{ id: string; text: string } | null>(null);
  const modalSearchRef = useRef<ReturnType<typeof setTimeout>>();
  const previewCacheRef = useRef<Map<string, {
    wps: SavedWaypoint[]; grade: PassportGrade | null; navigability: PreviewNavigability | null;
  }>>(new Map());
  const [tileDl, setTileDl] = useState<{ done: number; total: number } | null>(null);
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
      setTileDl({ done: 0, total: mapPlan.tiles });
      const onMsg = (e: MessageEvent) => {
        if ((e.data as { regionId?: string })?.regionId !== routeId) return;
        const m = e.data as { type: string; done: number; failed?: number; total: number };
        if (m.type === 'TILE_PROGRESS') setTileDl({ done: m.done, total: m.total });
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
      const restored = parseCrumbs(localStorage.getItem(crumbsKey(routeId)));
      crumbsRef.current = restored;
      setCrumbs(restored);
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
    const wpLine = waypoints.map(w => [w.lat, w.lng] as [number, number]);
    // Паутина «35 мест по всему краю»: сегменты >25 км — это не трек,
    // ломаную не рисуем, только точки (полевой скрин 20.07). К настоящему
    // треку это не относится: он путь, а не список мест.
    const fallback = wpLine.length >= 2 && !isScatteredCollection(wpLine) ? wpLine : null;
    /**
     * Линия, которой платформа уже не верит, не рисуется.
     *
     * Полевой скрин 17.08: карточка честно писала «Линия и точки маршрута
     * расходятся» и не показывала расстояние — и одновременно рисовала эту
     * линию через весь экран, от Магаданской области за восточный край.
     * Экран говорил и «не верь этому», и «вот путь» сразу; из двух сообщений
     * в поле читают то, которое нарисовано.
     *
     * Расхождение уже посчитано в approach (dataConflict): точки маршрута и
     * линия описывают разные места. Тогда линии нет — остаются точки, компас
     * и SOS, о чём карточка и говорит словами.
     *
     * Регресс 24.08: dataConflict раньше просто выключал ТРЕК, и код падал
     * на `fallback` — прямую между путевыми точками. На маршруте, где цель
     * стоит в стороне от геометрии, это именно тот полный экран уверенной
     * линии, от которого чинили 17.08, только в исполнении из точек, а не
     * из geometry. dataConflict значит «не знаем, как это связано между
     * собой» — фолбэк здесь не честнее самого трека, поэтому при нём линии
     * нет вовсе, не только трека.
     */
    const trackTrusted = track && track.length >= 2;
    const line = approach?.dataConflict === true ? null : (trackTrusted ? track : fallback);
    if (!line && waypoints.length === 0) return [];
    return [
      // Линия рисуется по своему происхождению. Часть маршрутов имеет
      // geometry, построенную прямыми от точки к точке (migration 168) — в
      // её же комментарии это названо «rough visual track». До экрана
      // оговорка не доезжала: ломаная приходила тем же полем и рисовалась
      // тем же сплошным зелёным, что и снятый GPS-трек.
      //
      // В поле разница решающая: по снятому треку идти можно, а прямая между
      // точками на камчатском рельефе проходит через каньон и реку — и
      // выглядит на карте так же уверенно.
      ...(line ? [{
        coords: line[0],
        title: activeRouteTitle ?? 'Маршрут',
        geometry: {
          type: 'polyline',
          coordinates: line,
          ...trackFidelityStyle(lineFidelity),
        } as MapMarkerGeometry,
        suppressBalloon: true,
      }] : []),
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
            } satisfies RoutePreview;
          }));
        })
        .catch(() => setSearchRoutes([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(modalSearchRef.current);
  }, [modalQuery, pickerVisible]);

  // Строка пути в выборе: род линии, длина, сложность. Одна на обе секции —
  // группы мест и плоский список рекомендуемых.
  function renderPathRow(r: RoutePreview) {
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
      preview && previewMap ? (
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
                      {/* Поиск по названию места */}
                      <input
                        type="text"
                        value={modalQuery}
                        onChange={e => setModalQuery(e.target.value)}
                        placeholder="Название места: Авачинский, Толбачик…"
                        className="w-full px-3 py-2.5 rounded-xl text-sm mb-3"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />
      
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
                            /* ── Выбор от МЕСТА (владелец 20.08): сначала место,
                                под ним — пути к нему, отсортированные по роду
                                линии и длине. Совпавшие только названием — своей
                                секцией в конце, честно подписанной. ── */
                            searchRoutes.length === 0 ? (
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                                  {searching ? 'Ищем пути…' : `Пути к «${modalQuery.trim()}»`}
                                </p>
                                <div className="text-[var(--text-muted)] text-sm text-center py-6">
                                  {searching ? 'Секунду…' : 'Ничего не нашлось — попробуйте другое место'}
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-4">
                                {groupRoutesByPlace(searchRoutes, modalQuery.trim()).map(g => (
                                  <div key={g.place ?? '__title__'}>
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                                      {g.place
                                        ? `${g.place} · ${g.routes.length} ${plural(g.routes.length, 'путь', 'пути', 'путей')}`
                                        : 'Совпали названием маршрута'}
                                    </p>
                                    <div className="space-y-2">
                                      {g.routes.map(r => renderPathRow(r))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )
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

  // ─── Полевые действия: место · трек · наблюдение (владелец 27.08) ─────────
  // Панель — та же, что на /field-check (FieldActionBar, образец MAPS.ME):
  // одно касание — одно действие. «Наблюдение» переехало сюда с главной:
  // здесь у него есть контекст — координаты и офлайн-статус система знает
  // сама. Запись трека уходит ТЕМ ЖЕ приёмником, что у /field-check.

  const recorder = useTrackRecorder();
  const [obsOpen, setObsOpen] = useState(false);
  const obsQueueLen = useTrailObservationQueue();
  const [fieldBarError, setFieldBarError] = useState<string | null>(null);
  const [sendingTrack, setSendingTrack] = useState(false);

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
    try {
      const b64 = typeof window === 'undefined'
        ? '' : btoa(unescape(encodeURIComponent(done.gpx)));
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
        setFieldBarError(data?.error ?? 'Трек не ушёл — он сохранён на телефоне, отправьте при связи');
        return;
      }
      await recorder.discard();
      setFieldBarError(null);
    } catch {
      setFieldBarError('Связи нет — трек сохранён на телефоне, отправится при связи');
    } finally {
      setSendingTrack(false);
    }
  }, [recorder, activeRouteTitle]);

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
          ? (recorder.silent
              ? 'сигнала нет'
              : [
                  recorder.summary.durationMin != null ? `${recorder.summary.durationMin} мин` : null,
                  `${recorder.summary.points} тчк`,
                  `${recorder.summary.lengthKm.toFixed(1)} км`,
                ].filter(Boolean).join(' · '))
          : (recorder.restored ? 'есть недописанная' : null),
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
  }, [recorder, sendingTrack, stopAndSendTrack, activeRouteTitle, obsQueueLen]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-[calc(100vh-56px)]" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {/* Приборная строка: качество фикса · маршрут · счёт точек, а под ней
          состояние данных (карта в телефоне, свежесть условий). Это первое,
          что читают, подняв телефон (макеты FCN). */}
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
          это тоже сообщение: всё в порядке, идите. */}
      {status && (
        <div
          className="flex items-center gap-2 px-4 py-2.5 text-xs"
          style={{
            background: status.tone === 'warn'
              ? 'color-mix(in srgb, var(--warning) 12%, transparent)'
              : 'color-mix(in srgb, var(--ocean) 10%, transparent)',
            borderBottom: '1px solid var(--border)',
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

      {/* Main content */}
      <div className="flex-1 px-4 py-6 flex flex-col items-center gap-6 max-w-sm mx-auto w-full">

        {!hasRoute && !isLoadingRoute ? (
          /* Destination-first (UX-коррекция владельца 27.08): цель, не
             готовый трек, — первый объект выбора. Прежде здесь стояла
             приборная заглушка с кнопкой, открывающей тот же поиск местом
             ВНУТРИ модалки; теперь это один и тот же инструмент
             (renderDestinationPicker), показанный сразу как основной экран,
             без клика и без чёрной подложки поверх карты. */
          <div className="w-full flex flex-col gap-5 py-6">
            <div className="text-center">
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

            <div className="text-xs text-[var(--text-muted)] space-y-1.5 text-center">
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

        {/* Приборы: главная цифра первой, компас — вторым (решение владельца
            21.08: герой экрана — то, что нужно каждому шагу, а компас чаще
            всего молчит). Порядок живёт в CSS order: при мёртвом фиксе цифра
            глушится, и компас — лучший из оставшихся приборов — поднимается
            наверх сам, как в ступени III деградации. */}
        <div className="flex flex-col items-center gap-4 w-full">
          <div className="w-full flex flex-col items-center gap-2"
            style={{ order: figuresLive ? 2 : 1 }}>
            <FieldCompass heading={effHeading} state={effCompassState}
              targetBearing={targetBearing} headingSource={headingSource} />
            {/* Лекарство — на самом приборе: кнопка в строке статуса от
                мёртвого компаса жила в другом углу экрана, и их не связывали. */}
            {compassState === 'blocked' && (
              <button onClick={enableCompass}
                className="text-sm font-semibold px-5 py-2.5 rounded-lg"
                style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)' }}>
                Включить компас
              </button>
            )}
          </div>
          <div className="text-center w-full" style={{ order: figuresLive ? 1 : 2 }}>
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

      {/* Bottom action grid */}
      <div className="grid grid-cols-2 gap-2 p-4" style={{ borderTop: '1px solid #21262d' }}>
        <button onClick={() => {
            setMapCenter(coords ? [coords.lat, coords.lng] : (waypoints[0] ? [waypoints[0].lat, waypoints[0].lng] : undefined));
            setShowMap(true);
          }}
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-sm transition-colors"
          style={{
            background: 'var(--bg-card)',
            color: 'var(--success)',
            border: '1px solid color-mix(in srgb, var(--success) 22%, transparent)',
            minHeight: 60,
          }}>
          <MapIcon className="w-5 h-5" /> КАРТА
        </button>
        {/* Условия — внутренний снимок из пакета, не внешняя ссылка:
            OpenWeatherMap в поле без сети — мёртвая кнопка, а решение
            «идти или нет» принимается по нашему safety-слою (план FCN:
            в active mode нет внешних переходов). */}
        <button onClick={openConditions}
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-sm transition-colors"
          style={{ background: 'var(--bg-card)', color: 'var(--ocean)', border: '1px solid color-mix(in srgb, var(--ocean) 25%, transparent)', minHeight: 60 }}>
          <CloudSun className="w-5 h-5" /> УСЛОВИЯ
        </button>
        {/* «Группа» вместо AI-чата: в активном режиме нет длинного разговора,
            есть план и контакт вне маршрута (макеты FCN, решение владельца).
            Кузьмич остаётся в шапке и на других экранах. */}
        <button onClick={() => setShowGroup(true)}
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-sm transition-colors"
          style={{ background: 'var(--bg-card)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', minHeight: 60 }}>
          <Users className="w-5 h-5" /> ГРУППА
        </button>
        {/* SOS — общий компонент, не своя кнопка: здесь жил сырой tel:112
            без офлайн-ветки. Копии SOS уже расходились поведением (#887),
            и полевой экран — последнее место, где это допустимо. */}
        <EmergencyAction variant="field" />
      </div>

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
            <a href="tel:112"
              className="flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-bold"
              style={{ background: 'var(--danger)', color: '#fff' }}>
              <Phone className="w-4 h-4" /> 112 — экстренный вызов
            </a>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              Диспетчеру нужны: название маршрута, ваше положение и время выхода.
            </p>
          </div>
        </div>
      )}

      {/* Карта с треком — офлайн-стойкая (тайлы из кэша SW). Точки берём из
          localStorage-кэша, позиция — с GPS. Как Maps.me: трек + твоя стрелка. */}
      {showMap && (
        <div className="fixed inset-0 z-[1000]" style={{ background: '#0d1117' }}>
          <LeafletMap
            markers={mapMarkers}
            center={mapCenter}
            zoom={12}
            height="100dvh"
            showUserLocation
          />
          <button onClick={() => setShowMap(false)}
            className="absolute top-4 left-4 z-[1001] w-11 h-11 rounded-full flex items-center justify-center"
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
          <div className="absolute inset-x-0 bottom-0 z-[1001] px-4"
            style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
            <FieldActionBar actions={fieldActions} error={fieldBarError} />
          </div>
        </div>
      )}

      {/* Навигаторный выбор маршрута: место → варианты → превью на карте → фиксация */}
      {showRouteModal && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => { setShowRouteModal(false); setPreview(null); }}>
          <div className="rounded-t-2xl p-4 max-h-[85vh] overflow-y-auto"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-[var(--text-primary)] text-base">Куда хотите пойти?</h3>
              <button onClick={() => { setShowRouteModal(false); setPreview(null); }}
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
          <p className="text-xs text-[var(--text-secondary)]">МЧС Камчатка · Горно-спасательная</p>
        </div>
        <a href="tel:112" className="text-sm font-bold px-3 py-1.5 rounded-lg text-white"
          style={{ background: 'var(--danger)' }}>
          112
        </a>
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
