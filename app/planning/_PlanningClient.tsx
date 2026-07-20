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

const Header = dynamic(
  () => import('@/components/layout/Header').then(m => ({ default: m.Header })),
  { ssr: false }
);

// Карта с треком — только на клиенте (Leaflet не SSR-безопасен)
const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false });

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
  { id: 'maps',      label: 'Карты скачаны (450 МБ)',       done: false },
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

function CompassDisplay({ heading }: { heading: number }) {
  const cardinals = [
    { label: 'N', angle: 0 }, { label: 'E', angle: 90 },
    { label: 'S', angle: 180 }, { label: 'W', angle: 270 },
  ];
  return (
    <div className="relative mx-auto" style={{ width: 160, height: 160 }}>
      <div className="absolute inset-0 rounded-full"
        style={{ background: 'var(--bg-primary)', border: '2px solid color-mix(in srgb, var(--success) 25%, transparent)' }} />
      <div className="absolute inset-2 rounded-full"
        style={{ border: '1px solid rgba(74,222,128,0.12)' }} />
      {cardinals.map(({ label, angle }) => {
        const rad = ((angle - heading) * Math.PI) / 180;
        const x = 80 + 62 * Math.sin(rad);
        const y = 80 - 62 * Math.cos(rad);
        return (
          <span key={label} className="absolute text-xs font-bold"
            style={{
              left: x, top: y,
              transform: 'translate(-50%, -50%)',
              color: label === 'N' ? 'var(--success)' : 'var(--text-muted)',
            }}>
            {label}
          </span>
        );
      })}
      {/* Needle — always points North relative to device */}
      <div className="absolute inset-0 flex items-center justify-center"
        style={{ transform: `rotate(${-heading}deg)`, transition: 'transform 0.3s ease' }}>
        <svg width="28" height="56" viewBox="0 0 28 56">
          <polygon points="14,0 8,28 14,24 20,28" fill="var(--success)" />
          <polygon points="14,56 8,28 14,32 20,28" fill="#4b5563" />
        </svg>
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-2 h-2 rounded-full bg-[var(--success)]" />
      </div>
    </div>
  );
}

// ─── Haversine distance (km) ──────────────────────────────────────────────────

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
  const [coords, setCoords] = useState<{ lat: number; lng: number; alt: number | null } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [isOffline, setIsOffline] = useState(false);
  const [gpsError, setGpsError] = useState(false);
  const watchRef = useRef<number | null>(null);
  // Ref so the timer closure always reads the current value without restarting sensors
  const startTimeRef = useRef(Date.now());
  const [waypoints, setWaypoints] = useState<SavedWaypoint[]>([]);
  const [currentWpIdx, setCurrentWpIdx] = useState(0);
  const [activeRouteTitle, setActiveRouteTitle] = useState<string | null>(null);
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

  // Этап 2 офлайн-карты: авто-докачка тайлов коридора маршрута (зум 10-12,
  // ~15 км паддинг) при активном маршруте. Один раз на маршрут (флаг), только
  // онлайн — чтобы в поле без сети карта с треком уже была закэширована.
  const prefetchTiles = useCallback(async (routeId: string) => {
    if (typeof navigator === 'undefined' || navigator.onLine === false) return;
    if (!navigator.serviceWorker) return;
    const flag = `tiles_cached_${routeId}`;
    try { if (localStorage.getItem(flag)) return; } catch { /* ignore */ }
    try {
      const res = await fetch(`/api/routes/${routeId}/offline-bundle`);
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.tile_urls) || data.tile_urls.length === 0) return;
      const reg = await navigator.serviceWorker.ready;
      const sw = reg.active;
      if (!sw) return;
      setTileDl({ done: 0, total: data.tile_count });
      const onMsg = (e: MessageEvent) => {
        if ((e.data as { regionId?: string })?.regionId !== routeId) return;
        const m = e.data as { type: string; done: number; total: number };
        if (m.type === 'TILE_PROGRESS') setTileDl({ done: m.done, total: m.total });
        if (m.type === 'TILES_DONE') {
          setTileDl(null);
          try { localStorage.setItem(flag, '1'); } catch { /* ignore */ }
          navigator.serviceWorker.removeEventListener('message', onMsg);
        }
      };
      navigator.serviceWorker.addEventListener('message', onMsg);
      sw.postMessage({ type: 'CACHE_TILES', tiles: data.tile_urls, regionId: routeId });
    } catch { /* тихо — не критично */ }
  }, []);

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
          void prefetchTiles(routeId); // авто-докачка тайлов коридора для офлайна
        }
      })
      .catch(() => { /* офлайн — уже показали кэш */ })
      .finally(() => setIsLoadingRoute(false));
  }, [prefetchTiles]);

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
    if (routeId) fetchRouteWaypoints(routeId);
  }, [fetchRouteWaypoints]);

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

  // Sensors + timer — run once on mount; timer reads startTimeRef at call time
  useEffect(() => {
    const handleOrientation = (e: DeviceOrientationEvent) => {
      // webkitCompassHeading = iOS true-North heading (0–360, clockwise)
      // deviceorientationabsolute + 360 - alpha = Android true-North equivalent
      const webkitHeading = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      const h = webkitHeading != null
        ? webkitHeading
        : (e.alpha !== null ? (360 - e.alpha) % 360 : null);
      if (h !== null) setHeading(h);
    };
    // deviceorientationabsolute gives Earth-frame absolute heading (Android Chrome)
    window.addEventListener('deviceorientationabsolute', handleOrientation as EventListener, true);
    window.addEventListener('deviceorientation', handleOrientation as EventListener);
    if ('geolocation' in navigator) {
      watchRef.current = navigator.geolocation.watchPosition(
        pos => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, alt: pos.coords.altitude }),
        err => { if (err.code === 1) setGpsError(true); },
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
    }
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => {
      window.removeEventListener('deviceorientationabsolute', handleOrientation as EventListener, true);
      window.removeEventListener('deviceorientation', handleOrientation as EventListener);
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      clearInterval(timer);
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

  // Auto-advance waypoint when within 50m
  useEffect(() => {
    if (!coords || waypoints.length === 0) return;
    const wp = waypoints[currentWpIdx];
    if (!wp) return;
    const dist = haversine(coords.lat, coords.lng, wp.lat, wp.lng);
    if (dist < 0.05 && currentWpIdx < waypoints.length - 1) {
      setCurrentWpIdx(i => i + 1);
    }
  }, [coords, waypoints, currentWpIdx]);

  // ─── Computed ──────────────────────────────────────────────────────────────

  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const altitude = coords?.alt != null ? Math.round(coords.alt) : null;
  const nextWp = waypoints[currentWpIdx] ?? null;

  // Маркеры для карты: линия трека + точки маршрута (текущая — оранжевая).
  // useMemo обязателен: LeafletMap пересоздаёт карту при смене identity
  // markers — пересборка на каждом рендере (GPS-тики) убивала карту.
  const mapMarkers: MapMarker[] = useMemo(() => {
    if (waypoints.length === 0) return [];
    const line = waypoints.map(w => [w.lat, w.lng] as [number, number]);
    // Паутина «35 мест по всему краю»: сегменты >25 км — это не трек,
    // линию не рисуем, только точки (полевой скрин 20.07)
    const scattered = isScatteredCollection(line);
    return [
      ...(scattered ? [] : [{
        coords: [waypoints[0].lat, waypoints[0].lng] as [number, number],
        title: activeRouteTitle ?? 'Маршрут',
        geometry: { type: 'polyline', coordinates: line, color: '#4ade80', weight: 4 } as MapMarkerGeometry,
        suppressBalloon: true,
      }]),
      ...waypoints.map((w, i): MapMarker => ({
        coords: [w.lat, w.lng],
        title: w.name,
        color: i === currentWpIdx ? 'orange' : 'green',
        type: MarkerType.POI,
      })),
    ];
  }, [waypoints, currentWpIdx, activeRouteTitle]);
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

  const distToNext = coords && nextWp
    ? haversine(coords.lat, coords.lng, nextWp.lat, nextWp.lng)
    : null;
  const distLabel = distToNext === null ? null
    : distToNext < 1
    ? `${Math.round(distToNext * 1000)} м`
    : `${distToNext.toFixed(1)} км`;

  // SVG track: normalize lat to y-axis — honest representation of waypoint positions
  const svgPoints = (() => {
    if (waypoints.length < 2) return null;
    const lats = waypoints.map(w => w.lat);
    const minLat = Math.min(...lats);
    const latRange = (Math.max(...lats) - minLat) || 0.001;
    return waypoints.map((wp, i) => ({
      x: (i / (waypoints.length - 1)) * 300 + 10,
      // Higher lat = higher on screen (invert because SVG y increases downward)
      y: 110 - ((wp.lat - minLat) / latRange) * 84,
      i,
    }));
  })();

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
      {/* Network / GPS banners */}
      <div
        className="flex items-center gap-2 px-4 py-2 text-xs"
        style={{
          background: isOffline
            ? 'color-mix(in srgb, var(--warning) 15%, transparent)'
            : 'color-mix(in srgb, var(--success) 12%, transparent)',
          borderBottom: isOffline
            ? '1px solid color-mix(in srgb, var(--warning) 25%, transparent)'
            : '1px solid color-mix(in srgb, var(--success) 20%, transparent)',
          color: isOffline ? 'var(--warning)' : 'var(--success)',
        }}
      >
        {isOffline ? <WifiOff className="w-3.5 h-3.5" /> : <Wifi className="w-3.5 h-3.5" />}
        {isOffline ? 'Офлайн-режим • Карты доступны' : 'Онлайн • GPS активен'}
      </div>
      {gpsError && (
        <div
          className="flex items-center gap-2 px-4 py-2 text-xs"
          style={{
            background: 'color-mix(in srgb, var(--warning) 15%, transparent)',
            borderBottom: '1px solid color-mix(in srgb, var(--warning) 25%, transparent)',
            color: 'var(--warning)',
          }}
        >
          <AlertCircle className="w-3.5 h-3.5" />
          Разрешите геолокацию в настройках браузера
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 px-4 py-6 flex flex-col items-center gap-6 max-w-sm mx-auto w-full">

        {/* Compass + route info */}
        <div className="flex flex-col md:flex-row items-center gap-6 w-full">
          <CompassDisplay heading={heading} />
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
                <p className="text-[var(--text-secondary)] text-sm mb-0.5">
                  Точка {Math.min(currentWpIdx + 1, waypoints.length)} из {waypoints.length}
                </p>
                <p className="text-[var(--text-muted)] text-xs mb-2">до следующей точки</p>
                <p className="text-5xl font-bold leading-none" style={{ color: 'var(--success)', letterSpacing: '-1px' }}>
                  {distLabel ?? '—'}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">{nextWp?.name ?? ''}</p>
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

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 w-full">
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <p className="text-[var(--text-muted)] text-xs uppercase tracking-wide mb-1">Высота</p>
            <p className="text-2xl font-bold text-[var(--text-primary)]">
              {altitude !== null ? `${altitude.toLocaleString('ru')}м` : '— м'}
              {altitude !== null && <span className="text-[var(--success)] text-base ml-0.5">↑</span>}
            </p>
          </div>
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <p className="text-[var(--text-muted)] text-xs uppercase tracking-wide mb-1">Время в пути</p>
            <p className="text-2xl font-bold text-[var(--text-primary)]">
              {hours}ч {mins.toString().padStart(2, '0')}м
            </p>
          </div>
        </div>

        {/* Route track */}
        <div className="w-full h-32 rounded-xl overflow-hidden"
          style={{ background: '#0d1b0e', border: '1px solid #1a3620' }}>
          {svgPoints ? (
            <svg className="w-full h-full" viewBox="0 0 320 128" preserveAspectRatio="none">
              {[32, 64, 96].map(y => (
                <line key={y} x1="0" y1={y} x2="320" y2={y}
                  stroke="rgba(74,222,128,0.06)" strokeWidth="1" />
              ))}
              <polyline
                points={svgPoints.map(p => `${p.x},${p.y}`).join(' ')}
                fill="none" stroke="var(--success)" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"
              />
              {svgPoints.map(({ x, y, i }) => (
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
              {isLoadingRoute ? 'Загрузка трека…' : 'Выберите маршрут для отображения трека'}
            </div>
          )}
        </div>

      </div>

      {/* Индикатор докачки офлайн-карты (Этап 2) */}
      {tileDl && tileDl.total > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs" style={{ color: 'var(--text-muted)', borderTop: '1px solid #21262d' }}>
          <Download className="w-3.5 h-3.5 animate-pulse" style={{ color: 'var(--success)' }} />
          Карта офлайн: {tileDl.done} / {tileDl.total}
          <span className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: '#21262d' }}>
            <span className="block h-full rounded-full" style={{ width: `${Math.round((tileDl.done / tileDl.total) * 100)}%`, background: 'var(--success)' }} />
          </span>
        </div>
      )}

      {/* Bottom action grid */}
      <div className="grid grid-cols-2 gap-2 p-4" style={{ borderTop: '1px solid #21262d' }}>
        <button onClick={() => {
            setMapCenter(coords ? [coords.lat, coords.lng] : (waypoints[0] ? [waypoints[0].lat, waypoints[0].lng] : undefined));
            setShowMap(true);
          }}
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-sm transition-colors"
          style={{ background: 'var(--bg-card)', color: 'var(--success)', border: '1px solid #1a3620', minHeight: 60 }}>
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
          {waypoints.length === 0 && (
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
                  <LeafletMap markers={previewMap.markers} center={previewMap.center} zoom={11} />
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
  const { status: mapsStatus, progress: mapsProgress, error: mapsError, download: downloadMaps } = useOfflineRegion('avacha-group');
  const [hasActiveRoute, setHasActiveRoute] = useState(false);

  useEffect(() => {
    setHasActiveRoute(!!localStorage.getItem('active_trail_route_id'));
  }, []);

  // Override 'done' for auto-computed items
  const effectiveChecklist = checklist.map(item => {
    if (item.id === 'maps') return { ...item, done: mapsStatus === 'cached' };
    if (item.id === 'offline') return { ...item, done: hasActiveRoute };
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
