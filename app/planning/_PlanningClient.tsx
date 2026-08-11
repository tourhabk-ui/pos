'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import Image from 'next/image';
import {
  Check, ChevronRight, Navigation, MapPin,
  Map as MapIcon, CloudSun, MessageCircle, Phone,
  AlertCircle, Wifi, WifiOff, X, ExternalLink, Download, Bot,
} from 'lucide-react';
import { useOfflineRegion } from '@/lib/offline/useOfflineRegion';
import { MarkerType, type MapMarker, type MapMarkerGeometry } from '@/components/shared/leaflet-types';
import { isScatteredCollection } from '@/lib/routes/geometry-compact';
import { approachPlan } from '@/lib/on-route/approach';
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
  trackFidelity, trackFidelityLabel, trackFidelityStyle, type TrackFidelity,
} from '@/lib/routes/track-fidelity';
import { addCrumb, parseCrumbs, serializeCrumbs, crumbsKey, type Crumb } from '@/lib/offline/breadcrumbs';
import {
  parseSavedMap, savedMapKey, savedMapSummary, requestPersistentStorage,
  type SavedMapRecord,
} from '@/lib/offline/saved-map';

const Header = dynamic(
  () => import('@/components/layout/Header').then(m => ({ default: m.Header })),
  { ssr: false }
);

// Карта с треком — только на клиенте (Leaflet не SSR-безопасен)
// Карта грузится отдельным куском (leaflet + markercluster). Без подписи
// нажатие на кнопку выглядело зависанием: чёрный экран на всё время загрузки
// чанка и первых тайлов, и ни одного признака, что что-то происходит
// (владелец 09.08: «карта открывается с большой задержкой»).
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
function CompassDisplay({ heading, state }: { heading: number; state: CompassState }) {
  const cardinals = [
    { label: 'N', angle: 0 }, { label: 'E', angle: 90 },
    { label: 'S', angle: 180 }, { label: 'W', angle: 270 },
  ];
  const trusted = state === 'ok';
  const needleColor = trusted ? 'var(--success)' : 'var(--text-muted)';
  return (
    <div className="relative mx-auto" style={{ width: 160, height: 160 }}>
      <div className="absolute inset-0 rounded-full"
        style={{ background: 'var(--bg-primary)', border: '2px solid color-mix(in srgb, var(--success) 25%, transparent)' }} />
      <div className="absolute inset-2 rounded-full"
        style={{ border: '1px solid rgba(74,222,128,0.12)' }} />
      {/* Кольцо сторон света крутится ТОЛЬКО с подтверждённым азимутом.
          Раньше guard стоял лишь на стрелке, и на скрине владельца 09.08
          вышло худшее из возможного: стрелка погашена и смотрит вверх, а
          кольцо развёрнуто на 270° — «север справа». Прибор из одного
          мёртвого датчика делал два противоречащих утверждения. */}
      {cardinals.map(({ label, angle }) => {
        const rad = ((angle - (trusted ? heading : 0)) * Math.PI) / 180;
        const x = 80 + 62 * Math.sin(rad);
        const y = 80 - 62 * Math.cos(rad);
        return (
          <span key={label} className="absolute text-xs font-bold"
            style={{
              left: x, top: y,
              transform: 'translate(-50%, -50%)',
              color: label === 'N' && trusted ? 'var(--success)' : 'var(--text-muted)',
              opacity: trusted ? 1 : 0.45,
            }}>
            {label}
          </span>
        );
      })}
      {/* Стрелка на север. Не подтверждён азимут — гасим и не крутим:
          движущаяся стрелка читается как рабочая. */}
      <div className="absolute inset-0 flex items-center justify-center"
        style={{
          transform: `rotate(${trusted ? -heading : 0}deg)`,
          transition: 'transform 0.3s ease',
          opacity: trusted ? 1 : 0.35,
        }}>
        <svg width="28" height="56" viewBox="0 0 28 56">
          <polygon points="14,0 8,28 14,24 20,28" fill={needleColor} />
          <polygon points="14,56 8,28 14,32 20,28" fill="#4b5563" />
        </svg>
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-2 h-2 rounded-full" style={{ background: needleColor }} />
      </div>
    </div>
  );
}

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
  const [preview, setPreview] = useState<{ id: string; title: string; wps: SavedWaypoint[] } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const modalSearchRef = useRef<ReturnType<typeof setTimeout>>();
  const previewCacheRef = useRef<Map<string, SavedWaypoint[]>>(new Map());
  const [tileDl, setTileDl] = useState<{ done: number; total: number } | null>(null);
  /** План скачивания: сколько это будет весить, пока не скачано. */
  const [mapPlan, setMapPlan] = useState<{
    tiles: number; mb: number; zooms: number[]; dropped: number[];
    coverage: 'corridor' | 'bbox'; bufferKm: number | null; urls: string[];
  } | null>(null);
  /** Заявление о том, что уже лежит в телефоне. */
  const [savedMap, setSavedMap] = useState<SavedMapRecord | null>(null);
  /** Свой след: крошки, по которым возвращаются, когда отказало остальное. */
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const crumbsRef = useRef<Crumb[]>([]);
  const crumbsRouteRef = useRef<string | null>(null);

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

  /** Скачать карту маршрута по явному нажатию. */
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
        const m = e.data as { type: string; done: number; total: number };
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
        }
      };
      navigator.serviceWorker.addEventListener('message', onMsg);
      sw.postMessage({ type: 'CACHE_TILES', tiles: mapPlan.urls, regionId: routeId });
    } catch { /* ignore */ }
  }, [mapPlan]);

  // Shared route loader. Точки маршрута нужны в поле без связи, поэтому:
  // сперва поднимаем из localStorage-кэша (офлайн-стойко), затем обновляем из
  // API если есть сеть и перекладываем в кэш на будущее.
  const fetchRouteWaypoints = useCallback((routeId: string) => {
    const cacheKey = `trail_route_wps_${routeId}`;

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
        // Отметка свежести ставится по факту успешного ответа, а не по
        // открытию экрана: иначе «снимок от 14:32» означал бы «я посмотрел в
        // 14:32», а не «данные такие на 14:32».
        setLiveDataAt(Date.now());
        const wps = data.waypoints;
        if (!Array.isArray(wps) || wps.length === 0) return;
        const converted: SavedWaypoint[] = (wps as Array<Record<string, unknown>>)
          .filter(w => w.lat != null && w.lng != null)
          .map(w => ({
            lat: Number(w.lat),
            lng: Number(w.lng),
            name: (w.placeName as string | null) ?? `Точка ${Number(w.position) + 1}`,
          }));
        if (converted.length > 0) {
          setWaypoints(converted);
          try { localStorage.setItem(cacheKey, JSON.stringify({ title: data.title as string, waypoints: converted })); } catch { /* квота */ }
          void loadMapPlan(routeId); // что уже скачано и сколько весит недостающее
        }
      })
      .catch(() => { /* офлайн — уже показали кэш */ })
      .finally(() => setIsLoadingRoute(false));
  }, [loadMapPlan]);

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

  // Старт с БЛИЖАЙШЕЙ точки при первом GPS-фиксе (а не всегда с №1 — иначе
  // «до точки 1» может быть за десятки км, если старт маршрута далеко).
  const snappedRef = useRef(false);
  useEffect(() => {
    if (snappedRef.current || !coords || waypoints.length === 0) return;
    let best = 0, bestD = Infinity;
    waypoints.forEach((w, i) => {
      const d = haversine(coords.lat, coords.lng, w.lat, w.lng);
      if (d < bestD) { bestD = d; best = i; }
    });
    setCurrentWpIdx(best);
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
   * Считается по плотности точек — флага в данных нет, миграция 168 ничего
   * не проставила (см. lib/routes/track-fidelity).
   */
  const lineFidelity: TrackFidelity = useMemo(() => {
    const wpLine = waypoints.map(w => [w.lat, w.lng] as [number, number]);
    const fallback = wpLine.length >= 2 && !isScatteredCollection(wpLine) ? wpLine : null;
    const line = track && track.length >= 2 ? track : fallback;
    // Ломаная, собранная нами из путевых точек, — заведомо набросок:
    // считать её плотность незачем, происхождение известно точно.
    if (!track || track.length < 2) return line ? 'sketch' : 'unknown';
    return trackFidelity(track);
  }, [track, waypoints]);

  /**
   * Путь от МЕСТА ЧЕЛОВЕКА вдоль тропы, а не по прямой через залив.
   *
   * Скриншот владельца 11.08: «до точки 20.3 км по прямой», человек в
   * Петропавловске, цель — в Авачинской бухте, трек уходит на юго-запад.
   * Прямая между ними пересекает залив: число честно буквально и бесполезно
   * по существу, а нарисованной линии не соответствует вовсе.
   */
  const approach = useMemo(() => {
    if (!coords || !nextWp || !track || track.length < 2) return null;
    return approachPlan(
      { lat: coords.lat, lng: coords.lng },
      { lat: nextWp.lat, lng: nextWp.lng },
      track.map(([lat, lng]) => ({ lat, lng })),
    );
  }, [coords, nextWp, track]);

  const mapMarkers: MapMarker[] = useMemo(() => {
    const wpLine = waypoints.map(w => [w.lat, w.lng] as [number, number]);
    // Паутина «35 мест по всему краю»: сегменты >25 км — это не трек,
    // ломаную не рисуем, только точки (полевой скрин 20.07). К настоящему
    // треку это не относится: он путь, а не список мест.
    const fallback = wpLine.length >= 2 && !isScatteredCollection(wpLine) ? wpLine : null;
    const line = track && track.length >= 2 ? track : fallback;
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
      ...(approach && approach.userOffTrack && coords ? [{
        coords: [coords.lat, coords.lng] as [number, number],
        title: 'Выход на тропу',
        geometry: {
          type: 'polyline',
          coordinates: [
            [coords.lat, coords.lng],
            [approach.joinAt.lat, approach.joinAt.lng],
          ] as Array<[number, number]>,
          color: 'gray', weight: 2, dashArray: '6 6',
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
  }, [track, waypoints, currentWpIdx, activeRouteTitle, crumbs, approach, coords]);
  // Карта превью варианта: identity стабильна на выбранный вариант —
  // LeafletMap пересоздаётся только при смене превью, не на каждом рендере
  const previewMap = useMemo(() => {
    if (!preview || preview.wps.length === 0) return null;
    const center: [number, number] = [preview.wps[0].lat, preview.wps[0].lng];
    const line = preview.wps.map(w => [w.lat, w.lng] as [number, number]);
    // Сборник мест по всему краю (сегменты >25 км) — не трек: линию не
    // рисуем и «Начать по маршруту» не предлагаем
    const scattered = isScatteredCollection(line);
    const markers: MapMarker[] = [
      ...(scattered ? [] : [{
        coords: center,
        title: preview.title,
        color: 'teal',
        type: MarkerType.POI,
        geometry: { type: 'polyline', coordinates: line, color: '#4ade80', weight: 4 } as MapMarkerGeometry,
      }]),
      ...preview.wps.map((w, i) => ({
        coords: [w.lat, w.lng] as [number, number],
        title: w.name,
        color: i === 0 ? 'orange' : 'green',
        type: MarkerType.POI,
      })),
    ];
    return { center, markers, scattered };
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

  // Плечи маршрута по линии между точками — основа прогресса.
  const legKms = useMemo(
    () => waypoints.slice(1).map((w, i) => haversine(waypoints[i].lat, waypoints[i].lng, w.lat, w.lng)),
    [waypoints],
  );
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
    const fromM = distanceAlongTrack(track, coords.lat, coords.lng);
    const toM = distanceAlongTrack(track, nextWp.lat, nextWp.lng);
    if (fromM === null || toM === null || toM <= fromM) return null;
    const r = remainingRelief(relief.points, fromM, toM);
    return r.points.length >= 2 ? r : null;
  }, [relief, track, coords, nextWp]);

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

  // Поиск маршрутов по названию места: /api/routes/search знает waypoints
  // (семантика + route_waypoints), «Авачинский» находит все маршруты через него
  useEffect(() => {
    const q = modalQuery.trim();
    clearTimeout(modalSearchRef.current);
    if (!showRouteModal || q.length < 2) { setSearchRoutes([]); setSearching(false); return; }
    setSearching(true);
    modalSearchRef.current = setTimeout(() => {
      fetch(`/api/routes/search?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then((d: unknown) => {
          const rows = (typeof d === 'object' && d !== null ? (d as Record<string, unknown>).routes : null);
          if (!Array.isArray(rows)) { setSearchRoutes([]); return; }
          setSearchRoutes(rows.slice(0, 8).map((r) => {
            const row = r as Record<string, unknown>;
            const via = Array.isArray(row.waypoint_names)
              ? (row.waypoint_names as string[]).slice(0, 3).join(' · ')
              : null;
            return {
              id: String(row.id),
              title: String(row.title),
              difficulty: (row.difficulty_level as string | null) ?? null,
              durationDays: null,
              distanceKm: row.distance_km != null ? Number(row.distance_km) : null,
              imageUrl: null,
              via,
            } satisfies RoutePreview;
          }));
        })
        .catch(() => setSearchRoutes([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(modalSearchRef.current);
  }, [modalQuery, showRouteModal]);

  // Тап по варианту — ПРЕВЬЮ на карте, не фиксация (как в навигаторе)
  function openPreview(r: RoutePreview) {
    const cached = previewCacheRef.current.get(r.id);
    if (cached) { setPreview({ id: r.id, title: r.title, wps: cached }); return; }
    setPreviewLoadingId(r.id);
    fetch(`/api/routes/${r.id}`)
      .then(res => res.json())
      .then((j: unknown) => {
        if (typeof j !== 'object' || j === null || !(j as Record<string, unknown>).success) return;
        const data = (j as Record<string, unknown>).data as Record<string, unknown>;
        const wps = data.waypoints;
        if (!Array.isArray(wps)) return;
        const converted: SavedWaypoint[] = (wps as Array<Record<string, unknown>>)
          .filter(w => w.lat != null && w.lng != null)
          .map(w => ({
            lat: Number(w.lat),
            lng: Number(w.lng),
            name: (w.placeName as string | null) ?? `Точка ${Number(w.position) + 1}`,
          }));
        if (converted.length === 0) return;
        previewCacheRef.current.set(r.id, converted);
        setPreview({ id: r.id, title: r.title, wps: converted });
      })
      .catch(() => { /* остаёмся на списке */ })
      .finally(() => setPreviewLoadingId(null));
  }

  function openRouteModal() {
    setShowRouteModal(true);
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
          } satisfies RoutePreview;
        }).filter(Boolean) as RoutePreview[];
        if (items.length === 0) setModalError('Маршруты не найдены');
        else setModalRoutes(items);
      })
      .catch(() => { setModalError('Ошибка сети — проверьте соединение'); });
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-[calc(100vh-56px)]" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
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
          {status.cta === 'compass' && (
            <button onClick={enableCompass} className="font-semibold underline underline-offset-2 shrink-0">
              Включить
            </button>
          )}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 px-4 py-6 flex flex-col items-center gap-6 max-w-sm mx-auto w-full">

        {!hasRoute && !isLoadingRoute ? (
          /* Идти некуда — значит и приборов быть не должно: одно понятное
             действие вместо компаса без сигнала и нулей в карточках. */
          <div className="flex flex-col items-center text-center gap-5 py-10">
            <div className="w-14 h-14 rounded-full flex items-center justify-center"
              style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)' }}>
              <MapPin className="w-7 h-7" style={{ color: 'var(--success)' }} />
            </div>
            <div>
              <p className="text-lg font-semibold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
                Маршрут не выбран
              </p>
              <p className="text-sm text-[var(--text-secondary)] mt-1.5 max-w-[280px]">
                Выберите маршрут — и экран станет навигатором: направление,
                расстояние до точки и время в пути.
              </p>
            </div>
            <button onClick={openRouteModal}
              className="inline-flex items-center gap-1.5 text-sm font-semibold px-5 py-2.5 rounded-lg"
              style={{ background: 'var(--success)', color: '#08210f' }}>
              Выбрать маршрут <ChevronRight className="w-4 h-4" />
            </button>
            <div className="text-xs text-[var(--text-muted)] space-y-1.5 pt-1">
              <p>Карты можно скачать заранее — в поле они работают без сети.</p>
              <p>Компас появится, если у телефона есть датчик.</p>
            </div>
          </div>
        ) : (
        <>

        {/* Compass + route info */}
        <div className="flex flex-col md:flex-row items-center gap-6 w-full">
          <CompassDisplay heading={heading} state={compassState} />
          <div className="text-center md:text-left">
            {isLoadingRoute ? (
              <div className="flex flex-col gap-2.5">
                <div className="h-3 w-32 rounded-full animate-pulse" style={{ background: 'var(--bg-card)' }} />
                <div className="h-10 w-24 rounded-lg animate-pulse" style={{ background: 'var(--bg-card)' }} />
                <div className="h-3 w-20 rounded-full animate-pulse" style={{ background: 'var(--bg-card)' }} />
              </div>
            ) : waypoints.length > 0 ? (
              <>
                {activeRouteTitle && (
                  <p className="text-[var(--success)] text-xs font-medium mb-0.5 truncate max-w-[180px]">{activeRouteTitle}</p>
                )}
                {/* Счётчик — про порядок, а у маршрута из одной точки порядка
                    нет. «Точка 1 из 1» рядом с «до следующей точки · 18.5 км»
                    читается как «вы пришли, идти ещё 18 километров» (скрин
                    владельца 10.08). Одна точка — цель, а не позиция. */}
                {waypoints.length > 1 && (
                  <p className="text-[var(--text-secondary)] text-sm mb-0.5">
                    Точка {Math.min(currentWpIdx + 1, waypoints.length)} из {waypoints.length}
                  </p>
                )}
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
                    <p className="text-[var(--text-muted)] text-xs mb-2">
                      {waypoints.length > 1 ? 'до следующей точки' : 'до точки'}
                    </p>
                    {/* Мёртвый фикс не стирает цифру — это последнее, что человек
                        знает о своём положении, — но и не выдаёт её за текущую. */}
                    <p className="text-5xl font-bold leading-none"
                      style={{
                        color: figuresLive ? 'var(--success)' : 'var(--text-muted)',
                        letterSpacing: '-1px',
                      }}>
                      {distLabel}
                    </p>
                    {/* Имя точки печатаем, только если оно добавляет знание:
                        у маршрута из одной точки оно повторяло заголовок. */}
                    {nextWp?.name && nextWp.name !== activeRouteTitle && (
                      <p className="text-xs text-[var(--text-muted)] mt-1">{nextWp.name}</p>
                    )}
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

                {/* Слой хода: когда придём и сколько уже прошли. Одна цифра
                    «осталось» не отвечает на вопрос поля (владелец 09.08).
                    Без расстояния считать нечего — тогда и строк нет: «придём
                    через —» это не сдержанность, а вид поломки. */}
                {distLabel !== null && (
                <div className="mt-3 flex flex-col gap-1.5">
                  <p className="text-sm text-[var(--text-secondary)]">
                    <span className="text-[var(--text-muted)]">придём через</span>{' '}
                    <span className="font-semibold text-[var(--text-primary)]">{formatEta(eta.hours)}</span>
                  </p>
                  {etaNote && <p className="text-[11px] text-[var(--text-muted)] leading-tight">{etaNote}</p>}
                  {progress.totalKm > 0 && (
                    <>
                      <p className="text-sm text-[var(--text-secondary)]">
                        <span className="text-[var(--text-muted)]">пройдено</span>{' '}
                        <span className="font-semibold text-[var(--text-primary)]">
                          {progress.doneKm.toFixed(1)} / {progress.totalKm.toFixed(1)} км
                        </span>{' '}
                        <span className="text-[var(--text-muted)]">· {progress.percent}%</span>
                      </p>
                      <div className="h-1.5 rounded-full overflow-hidden w-full max-w-[200px]" style={{ background: 'var(--bg-hover)' }}>
                        <div className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${progress.percent}%`, background: 'var(--success)' }} />
                      </div>
                    </>
                  )}
                </div>

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
                    десятки мегабайт мобильного трафика (скрин владельца 10.08,
                    «Сохранить карту · 0 МБ»). */}
                {mapPlan.mb > 0 ? `Сохранить карту · ${mapPlan.mb} МБ` : 'Сохранить карту'}
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
        <a href={coords
            ? `https://openweathermap.org/weathermap?lat=${coords.lat}&lon=${coords.lng}&zoom=10`
            : 'https://openweathermap.org/city/2124044'}
          target="_blank" rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-sm transition-colors"
          style={{ background: 'var(--bg-card)', color: 'var(--ocean)', border: '1px solid #1e3a5f', minHeight: 60 }}>
          <CloudSun className="w-5 h-5" /> ПОГОДА
        </a>
        <Link href="/ai-assistant"
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-sm transition-colors"
          style={{ background: 'var(--bg-card)', color: 'var(--accent)', border: '1px solid #431a07', minHeight: 60 }}>
          <MessageCircle className="w-5 h-5" /> КУЗЬМИЧ
        </Link>
        <a href="tel:112"
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-xl transition-colors"
          style={{ background: 'var(--danger)', color: 'var(--text-primary)', border: '1px solid var(--danger)', minHeight: 60 }}>
          <Phone className="w-5 h-5" /> SOS
        </a>
      </div>

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
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm whitespace-nowrap"
              style={{ background: 'rgba(13,17,23,0.9)', color: 'var(--text-muted)', border: '1px solid #30363d' }}>
              Маршрут не выбран — карта без трека
            </div>
          )}
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
              <h3 className="font-bold text-[var(--text-primary)] text-base">Куда идём?</h3>
              <button onClick={() => { setShowRouteModal(false); setPreview(null); }}
                className="p-1.5 rounded-lg" style={{ background: 'var(--bg-card)' }}>
                <X className="w-4 h-4 text-[var(--text-muted)]" />
              </button>
            </div>

            {preview && previewMap ? (
              /* ── Превью варианта на карте (фиксация только кнопкой) ── */
              <div>
                <div className="rounded-xl overflow-hidden mb-3" style={{ height: 220, border: '1px solid var(--border)' }}>
                  {/* height обязателен: без него LeafletMap берёт дефолт 400px в
                      220px overflow-hidden контейнере — fitBounds центрирует
                      маркеры в обрезанную нижнюю половину, и превью выглядит
                      пустым (скрин владельца «Авачинский перевал»). */}
                  <LeafletMap markers={previewMap.markers} center={previewMap.center} zoom={11} height="220px" />
                </div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{preview.title}</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5 mb-3">
                  {preview.wps.length} точек · {preview.wps[0].name} → {preview.wps[preview.wps.length - 1].name}
                </p>
                {previewMap.scattered && (
                  <p className="text-xs mb-3 px-3 py-2 rounded-lg"
                    style={{ background: 'var(--bg-hover)', color: 'var(--warning)' }}>
                    Это подборка мест по всему краю, а не единый трек — идти по ней
                    как по маршруту нельзя. Выберите компактный маршрут из вариантов.
                  </p>
                )}
                <div className="flex gap-2">
                  <button onClick={() => setPreview(null)}
                    className="flex-1 text-xs font-semibold px-4 py-2.5 rounded-lg"
                    style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                    К вариантам
                  </button>
                  {!previewMap.scattered && (
                    <button onClick={() => selectRoute(preview)}
                      className="flex-1 text-xs font-bold px-4 py-2.5 rounded-lg"
                      style={{ background: 'rgba(74,222,128,0.15)', color: 'var(--success)', border: '1px solid rgba(74,222,128,0.3)' }}>
                      Начать по маршруту
                    </button>
                  )}
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
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                      {modalQuery.trim().length >= 2
                        ? (searching ? 'Ищем маршруты…' : `Маршруты через «${modalQuery.trim()}»`)
                        : 'Рекомендуемые'}
                    </p>
                    {(modalQuery.trim().length >= 2 ? searchRoutes : modalRoutes).length === 0 ? (
                      <div className="text-[var(--text-muted)] text-sm text-center py-6">
                        {modalQuery.trim().length >= 2
                          ? (searching ? 'Секунду…' : 'Ничего не нашлось — попробуйте другое место')
                          : 'Загрузка маршрутов…'}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {(modalQuery.trim().length >= 2 ? searchRoutes : modalRoutes).map(r => (
                          <button key={r.id} onClick={() => openPreview(r)}
                            className="w-full flex items-center gap-3 p-3 rounded-xl text-left"
                            style={{
                              background: 'var(--bg-primary)',
                              border: '1px solid var(--border)',
                              opacity: previewLoadingId === r.id ? 0.6 : 1,
                            }}>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-[var(--text-primary)] truncate">{r.title}</p>
                              <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
                                {r.distanceKm ? `${r.distanceKm} км · ` : ''}
                                {r.difficulty ? (DIFFICULTY_LABELS[r.difficulty] ?? r.difficulty) : '—'}
                                {r.via ? ` · через: ${r.via}` : ''}
                              </p>
                            </div>
                            <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--ocean)' }}>
                              {previewLoadingId === r.id ? '…' : 'На карте'}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
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
    // maps — trigger download if not started yet
    if (id === 'maps') {
      if (mapsStatus === 'idle' || mapsStatus === 'error') downloadMaps();
      return;
    }
    // mchs opens a form URL
    if (id === 'mchs') {
      window.open('https://forms.mchs.gov.ru/registration_tourist_groups/form', '_blank', 'noopener,noreferrer');
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

  function handleStartTrail(routeId: string) {
    try { localStorage.setItem('active_trail_route_id', routeId); } catch { /* ignore */ }
    setTab('trail');
  }

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {tab === 'planning' && <Header />}

      {/* Tab bar */}
      <div className={`sticky z-40 ${tab === 'planning' ? 'top-[56px]' : 'top-0'}`}
        style={{ background: tab === 'trail' ? 'var(--bg-primary)' : 'var(--bg-card)', borderBottom: `1px solid ${tab === 'trail' ? 'var(--bg-card)' : 'var(--border)'}` }}>
        <div className="max-w-2xl mx-auto px-4 flex gap-0">
          <button
            onClick={() => setTab('planning')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'planning'
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Navigation className="w-4 h-4" /> Планирование
          </button>
          <button
            onClick={() => setTab('trail')}
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
