'use client';

import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import Image from 'next/image';
import {
  Check, ChevronRight, Navigation, MapPin,
  Map as MapIcon, CloudSun, MessageCircle, Phone,
  AlertCircle, Wifi, WifiOff, X, ExternalLink,
} from 'lucide-react';
import { useOfflineRegion } from '@/lib/offline/useOfflineRegion';

const Header = dynamic(
  () => import('@/components/layout/Header').then(m => ({ default: m.Header })),
  { ssr: false }
);

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
  durationHours: number | null;
  distanceKm: number | null;
  imageUrl: string | null;
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

function RouteCard({ route }: { route: RoutePreview }) {
  return (
    <Link
      href={`/routes/${route.id}`}
      className="flex-shrink-0 rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/40 transition-all"
      style={{ width: 160 }}
    >
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
      <div className="p-2">
        <p className="text-xs font-semibold text-[var(--text-primary)] line-clamp-2 leading-snug">{route.title}</p>
        {(route.durationHours || route.distanceKm) && (
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            {route.durationHours ? `${route.durationHours} ч` : ''}
            {route.durationHours && route.distanceKm ? ' · ' : ''}
            {route.distanceKm ? `${route.distanceKm} км` : ''}
          </p>
        )}
      </div>
    </Link>
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
        style={{ background: '#0a0a0a', border: '2px solid rgba(74,222,128,0.25)' }} />
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
              color: label === 'N' ? '#4ade80' : '#6b7280',
            }}>
            {label}
          </span>
        );
      })}
      {/* Needle — always points North relative to device */}
      <div className="absolute inset-0 flex items-center justify-center"
        style={{ transform: `rotate(${-heading}deg)`, transition: 'transform 0.3s ease' }}>
        <svg width="28" height="56" viewBox="0 0 28 56">
          <polygon points="14,0 8,28 14,24 20,28" fill="#4ade80" />
          <polygon points="14,56 8,28 14,32 20,28" fill="#4b5563" />
        </svg>
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-2 h-2 rounded-full bg-[#4ade80]" />
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
  const [startTime] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [isOffline, setIsOffline] = useState(false);
  const watchRef = useRef<number | null>(null);
  const [waypoints, setWaypoints] = useState<SavedWaypoint[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('active_trail_waypoints');
      return raw ? (JSON.parse(raw) as SavedWaypoint[]) : [];
    } catch { return []; }
  });
  const [currentWpIdx, setCurrentWpIdx] = useState(0);
  const [activeRouteTitle, setActiveRouteTitle] = useState<string | null>(null);
  const [showRouteModal, setShowRouteModal] = useState(false);
  const [modalRoutes, setModalRoutes] = useState<RoutePreview[]>([]);

  useEffect(() => {
    setIsOffline(!navigator.onLine);
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  // Load waypoints from active route
  useEffect(() => {
    const routeId = localStorage.getItem('active_trail_route_id');
    if (!routeId) return;
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
        if (converted.length > 0) setWaypoints(converted);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Wake Lock — keep screen on while navigating
    let wakeLock: WakeLockSentinel | null = null;
    if ('wakeLock' in navigator) {
      (navigator.wakeLock as WakeLock).request('screen').then(wl => { wakeLock = wl; }).catch(() => {});
    }
    return () => { wakeLock?.release().catch(() => {}); };
  }, []);

  useEffect(() => {
    // Compass
    const handleOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha !== null) setHeading(e.alpha);
    };
    window.addEventListener('deviceorientation', handleOrientation);
    // GPS
    if ('geolocation' in navigator) {
      watchRef.current = navigator.geolocation.watchPosition(
        pos => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, alt: pos.coords.altitude }),
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
    }
    // Timer
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => {
      window.removeEventListener('deviceorientation', handleOrientation);
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      clearInterval(timer);
    };
  }, [startTime]);

  // Auto-advance to next waypoint when within 50m
  useEffect(() => {
    if (!coords || waypoints.length === 0) return;
    const wp = waypoints[currentWpIdx];
    if (!wp) return;
    const dist = haversine(coords.lat, coords.lng, wp.lat, wp.lng);
    if (dist < 0.05 && currentWpIdx < waypoints.length - 1) {
      setCurrentWpIdx(i => i + 1);
    }
  }, [coords, waypoints, currentWpIdx]);

  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const altitude = coords?.alt !== null && coords?.alt !== undefined ? Math.round(coords.alt) : null;

  const nextWp = waypoints[currentWpIdx] ?? null;
  const distToNext = coords && nextWp
    ? haversine(coords.lat, coords.lng, nextWp.lat, nextWp.lng)
    : null;

  return (
    <div className="flex flex-col min-h-[calc(100vh-56px)]" style={{ background: '#0d1117', color: '#f0f6fc' }}>
      {/* Offline banner */}
      <div className={`flex items-center gap-2 px-4 py-2 text-xs ${
        isOffline
          ? 'bg-yellow-900/40 border-b border-yellow-700/30 text-yellow-400'
          : 'bg-green-900/30 border-b border-green-800/30 text-green-400'
      }`}>
        {isOffline ? <WifiOff className="w-3.5 h-3.5" /> : <Wifi className="w-3.5 h-3.5" />}
        {isOffline ? 'Офлайн-режим • Карты доступны' : 'Онлайн • GPS активен'}
      </div>

      {/* Main content */}
      <div className="flex-1 px-4 py-6 flex flex-col items-center gap-6 max-w-sm mx-auto w-full">
        {/* Compass + distance */}
        <div className="flex flex-col md:flex-row items-center gap-6 w-full">
          <CompassDisplay heading={heading} />
          <div className="text-center md:text-left">
            {waypoints.length > 0 ? (
              <>
                {activeRouteTitle && (
                  <p className="text-green-400 text-xs font-medium mb-0.5 truncate max-w-[180px]">{activeRouteTitle}</p>
                )}
                <p className="text-gray-400 text-sm mb-0.5">
                  Точка {Math.min(currentWpIdx + 1, waypoints.length)} из {waypoints.length}
                </p>
                <p className="text-gray-500 text-xs mb-2">до следующей точки</p>
                <p className="text-5xl font-bold" style={{ color: '#4ade80', letterSpacing: '-1px' }}>
                  {distToNext !== null ? distToNext.toFixed(1) : '—'} <span className="text-2xl">км</span>
                </p>
                <p className="text-xs text-gray-500 mt-1">{nextWp?.name ?? ''}</p>
              </>
            ) : (
              <>
                <p className="text-gray-500 text-sm mb-2">нет активного маршрута</p>
                <button
                  onClick={() => {
                    setShowRouteModal(true);
                    if (modalRoutes.length === 0) {
                      fetch('/api/routes?limit=10&sort=popular')
                        .then(r => r.json())
                        .then((d: unknown) => {
                          if (typeof d !== 'object' || d === null || !(d as Record<string, unknown>).success) return;
                          const items = ((d as Record<string, unknown>).data as unknown[]).slice(0, 10).map(r => {
                            if (typeof r !== 'object' || r === null) return null;
                            const row = r as Record<string, unknown>;
                            return {
                              id: row.id as string,
                              title: row.title as string,
                              difficulty: (row.difficulty as string | null) ?? null,
                              durationHours: row.durationHours != null ? Number(row.durationHours) : null,
                              distanceKm: row.distanceKm != null ? Number(row.distanceKm) : null,
                              imageUrl: null,
                            } satisfies RoutePreview;
                          }).filter(Boolean) as RoutePreview[];
                          setModalRoutes(items);
                        })
                        .catch(() => {});
                    }
                  }}
                  className="inline-flex items-center gap-1 text-sm font-medium px-3 py-1.5 rounded-lg"
                  style={{ background: 'rgba(74,222,128,0.1)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.2)' }}>
                  Выбрать маршрут <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 w-full">
          <div className="rounded-xl p-4" style={{ background: '#161b22', border: '1px solid #30363d' }}>
            <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Высота</p>
            <p className="text-2xl font-bold text-white">
              {altitude !== null
                ? `${altitude.toLocaleString('ru')}м`
                : '— м'}
              {altitude !== null && <span className="text-green-400 text-base ml-0.5">↑</span>}
            </p>
          </div>
          <div className="rounded-xl p-4" style={{ background: '#161b22', border: '1px solid #30363d' }}>
            <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">Время в пути</p>
            <p className="text-2xl font-bold text-white">
              ~{hours}ч{mins.toString().padStart(2, '0')}м
            </p>
            <p className="text-xs text-gray-600">ходьбы</p>
          </div>
        </div>

        {/* Route track placeholder */}
        <div className="w-full h-32 rounded-xl overflow-hidden relative"
          style={{ background: '#0d1b0e', border: '1px solid #1a3620' }}>
          {waypoints.length > 0 ? (
            <svg className="w-full h-full" viewBox="0 0 320 128" preserveAspectRatio="none">
              {/* Background topographic lines */}
              {[20, 40, 60, 80, 100].map(y => (
                <path key={y} d={`M0,${y} Q80,${y - 5} 160,${y + 3} T320,${y}`}
                  fill="none" stroke="rgba(74,222,128,0.07)" strokeWidth="1" />
              ))}
              {/* Route line */}
              <polyline
                points={waypoints.map((wp, i) => `${(i / (waypoints.length - 1)) * 300 + 10},${64 + (Math.sin(i) * 20)}`).join(' ')}
                fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round"
              />
              {/* Waypoint dots */}
              {waypoints.map((_, i) => (
                <circle key={i}
                  cx={(i / (waypoints.length - 1)) * 300 + 10}
                  cy={64 + (Math.sin(i) * 20)}
                  r={i === currentWpIdx ? 5 : 3}
                  fill={i < currentWpIdx ? '#4ade80' : i === currentWpIdx ? '#ff6b35' : '#374151'}
                  stroke={i === currentWpIdx ? '#ff6b35' : 'none'}
                  strokeWidth="2"
                />
              ))}
            </svg>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-700 text-xs">
              Выберите маршрут для отображения трека
            </div>
          )}
        </div>
      </div>

      {/* Bottom action grid */}
      <div className="grid grid-cols-2 gap-2 p-4" style={{ borderTop: '1px solid #21262d' }}>
        <Link href="/map"
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-sm transition-colors"
          style={{ background: '#161b22', color: '#4ade80', border: '1px solid #1a3620', minHeight: 60 }}>
          <MapIcon className="w-5 h-5" /> КАРТА
        </Link>
        <a href={coords ? `https://openweathermap.org/weathermap?lat=${coords.lat}&lon=${coords.lng}&zoom=10` : '/routes'}
          target={coords ? '_blank' : undefined}
          rel={coords ? 'noopener noreferrer' : undefined}
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-sm transition-colors"
          style={{ background: '#161b22', color: '#60a5fa', border: '1px solid #1e3a5f', minHeight: 60 }}>
          <CloudSun className="w-5 h-5" /> ПОГОДА
        </a>
        <Link href="/ai-assistant"
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-sm transition-colors"
          style={{ background: '#161b22', color: '#fb923c', border: '1px solid #431a07', minHeight: 60 }}>
          <MessageCircle className="w-5 h-5" /> КУЗЬМИЧ
        </Link>
        <a href="tel:112"
          className="flex items-center justify-center gap-2 rounded-xl font-bold text-xl transition-colors"
          style={{ background: '#b91c1c', color: '#ffffff', border: '1px solid #ef4444', minHeight: 60 }}>
          <Phone className="w-5 h-5" /> SOS
        </a>
      </div>

      {/* Route selection modal */}
      {showRouteModal && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setShowRouteModal(false)}>
          <div className="rounded-t-2xl p-4 max-h-[80vh] overflow-y-auto"
            style={{ background: '#161b22', border: '1px solid #30363d' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-white text-base">Выбрать маршрут</h3>
              <button onClick={() => setShowRouteModal(false)}
                className="p-1.5 rounded-lg"
                style={{ background: '#21262d' }}>
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
            {modalRoutes.length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-6">Загрузка маршрутов…</div>
            ) : (
              <div className="space-y-2">
                {modalRoutes.map(r => (
                  <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl"
                    style={{ background: '#0d1117', border: '1px solid #21262d' }}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{r.title}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {r.distanceKm ? `${r.distanceKm} км · ` : ''}
                        {r.difficulty ? DIFFICULTY_LABELS[r.difficulty] ?? r.difficulty : '—'}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        try { localStorage.setItem('active_trail_route_id', r.id); } catch { /* ignore */ }
                        setShowRouteModal(false);
                        setActiveRouteTitle(r.title);
                        setWaypoints([]);
                        setCurrentWpIdx(0);
                        fetch(`/api/routes/${r.id}`)
                          .then(res => res.json())
                          .then((j: unknown) => {
                            if (typeof j !== 'object' || j === null || !(j as Record<string, unknown>).success) return;
                            const data = (j as Record<string, unknown>).data as Record<string, unknown>;
                            const wps = data.waypoints;
                            if (!Array.isArray(wps) || wps.length === 0) return;
                            const converted: SavedWaypoint[] = (wps as Array<Record<string, unknown>>)
                              .filter(w => w.lat != null && w.lng != null)
                              .map(w => ({
                                lat: Number(w.lat),
                                lng: Number(w.lng),
                                name: (w.placeName as string | null) ?? `Точка ${Number(w.position) + 1}`,
                              }));
                            if (converted.length > 0) setWaypoints(converted);
                          })
                          .catch(() => {});
                      }}
                      className="text-xs font-bold px-3 py-1.5 rounded-lg shrink-0"
                      style={{ background: 'rgba(74,222,128,0.15)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.3)' }}>
                      Начать
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Планирование tab ─────────────────────────────────────────────────────────

function PlanningTab() {
  const [checklist, setChecklist] = useState<ChecklistItem[]>(DEFAULT_CHECKLIST);
  const [routes, setRoutes] = useState<RoutePreview[]>([]);
  const [kuzmichTip, setKuzmichTip] = useState<string | null>(null);
  const emergencyRef = useRef<HTMLDivElement>(null);

  // Reactive checklist state
  const { status: mapsStatus } = useOfflineRegion('avacha-group');
  const [hasActiveRoute, setHasActiveRoute] = useState(false);

  useEffect(() => {
    setHasActiveRoute(!!localStorage.getItem('active_trail_route_id'));
  }, []);

  // Override 'done' for auto-computed items
  const effectiveChecklist = checklist.map(item => {
    if (item.id === 'maps') return { ...item, done: mapsStatus === 'cached' };
    if (item.id === 'offline') return { ...item, done: hasActiveRoute };
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
    fetch('/api/routes?limit=8&sort=popular')
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
              durationHours: row.durationHours != null ? Number(row.durationHours) : null,
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
    // Auto-computed items can't be manually toggled
    if (id === 'maps' || id === 'offline') return;
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
    setChecklist(prev => {
      const next = prev.map(item => item.id === id ? { ...item, done: !item.done } : item);
      try { localStorage.setItem('trip_checklist', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  const doneCount = effectiveChecklist.filter(i => i.done).length;

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 pb-32 space-y-6">
      {/* Kuzmich recommendation banner */}
      <div className="rounded-2xl overflow-hidden"
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
              <div className="w-9 h-9 rounded-full overflow-hidden shrink-0 bg-[var(--accent)] flex items-center justify-center text-base"
                style={{ border: '2px solid rgba(255,255,255,0.6)' }}>
                🐻
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
          <Link href="/ai-assistant"
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl font-semibold text-sm text-white transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent)' }}>
            Собрать маршрут <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {/* Checklist */}
      <div className="rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-4 mb-5">
          <ProgressRing done={doneCount} total={effectiveChecklist.length} />
          <div>
            <h2 className="font-bold text-[var(--text-primary)]">Готовность к походу</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {doneCount === effectiveChecklist.length ? 'Всё готово! Удачного похода.' : `Выполнено ${doneCount} из ${effectiveChecklist.length}`}
            </p>
          </div>
        </div>
        <div className="space-y-2">
          {effectiveChecklist.map(item => {
            const isAction = item.id === 'mchs' || item.id === 'emergency';
            return (
              <button
                key={item.id}
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
                {isAction && !item.done && (
                  <ExternalLink className="w-3.5 h-3.5 text-[var(--ocean)] shrink-0" />
                )}
              </button>
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
            {routes.map(route => <RouteCard key={route.id} route={route} />)}
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

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {tab === 'planning' && <Header />}

      {/* Tab bar */}
      <div className={`sticky z-40 ${tab === 'planning' ? 'top-[56px]' : 'top-0'}`}
        style={{ background: tab === 'trail' ? '#0d1117' : 'var(--bg-card)', borderBottom: `1px solid ${tab === 'trail' ? '#21262d' : 'var(--border)'}` }}>
        <div className="max-w-2xl mx-auto px-4 flex gap-0">
          <button
            onClick={() => setTab('planning')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'planning'
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : tab === 'trail'
                  ? 'border-transparent text-gray-500 hover:text-gray-300'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Navigation className="w-4 h-4" /> Планирование
          </button>
          <button
            onClick={() => setTab('trail')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'trail'
                ? 'border-green-500 text-green-400'
                : tab === 'trail'
                  ? 'border-transparent text-gray-500 hover:text-gray-300'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <MapPin className="w-4 h-4" /> На маршруте
          </button>
        </div>
      </div>

      {tab === 'planning' && <PlanningTab />}
      {tab === 'trail' && <OnTrailTab />}
    </div>
  );
}
