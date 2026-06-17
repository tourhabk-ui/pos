'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Map, CloudSun, MessageSquare, Navigation, ArrowLeft, Wifi, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface Waypoint {
  name: string;
  lat: number;
  lng: number;
}


function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Compass needle SVG
function Compass({ heading, bearing }: { heading: number; bearing: number }) {
  const needleAngle = (bearing - heading + 360) % 360;
  const ticks = [0, 45, 90, 135, 180, 225, 270, 315];
  const labels: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

  return (
    <div className="relative" style={{ width: 200, height: 200 }}>
      <svg width="200" height="200" viewBox="0 0 200 200">
        {/* Outer ring */}
        <circle cx="100" cy="100" r="96" fill="none" stroke="#1a1a1a" strokeWidth="3" />
        <circle cx="100" cy="100" r="90" fill="#0a0a0a" stroke="#2a2a2a" strokeWidth="1" />

        {/* Tick marks + labels */}
        {ticks.map(deg => {
          const rad = (deg - 90) * Math.PI / 180;
          const x1 = 100 + 82 * Math.cos(rad);
          const y1 = 100 + 82 * Math.sin(rad);
          const x2 = 100 + (labels[deg] ? 70 : 74) * Math.cos(rad);
          const y2 = 100 + (labels[deg] ? 70 : 74) * Math.sin(rad);
          const lx = 100 + 58 * Math.cos(rad);
          const ly = 100 + 58 * Math.sin(rad);
          return (
            <g key={deg}>
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={labels[deg] ? '#00e676' : '#444'} strokeWidth={labels[deg] ? 2 : 1} />
              {labels[deg] && (
                <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central"
                  fill={labels[deg] === 'N' ? '#00e676' : '#888'} fontSize="14" fontWeight="bold">
                  {labels[deg]}
                </text>
              )}
            </g>
          );
        })}

        {/* Needle — points to destination bearing */}
        <g transform={`rotate(${needleAngle}, 100, 100)`}>
          <polygon points="100,30 95,100 100,110 105,100" fill="#00e676" />
          <polygon points="100,170 95,100 100,110 105,100" fill="#444" />
          <circle cx="100" cy="100" r="6" fill="#111" stroke="#00e676" strokeWidth="2" />
        </g>
      </svg>
    </div>
  );
}

// Mini SVG track
function MiniTrack({ waypoints, currentIdx }: { waypoints: Waypoint[]; currentIdx: number }) {
  if (waypoints.length < 2) return null;
  const lats = waypoints.map(w => w.lat);
  const lngs = waypoints.map(w => w.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const pad = 10;
  const W = 280, H = 90;

  const toX = (lng: number) => pad + ((lng - minLng) / (maxLng - minLng || 1)) * (W - 2 * pad);
  const toY = (lat: number) => H - pad - ((lat - minLat) / (maxLat - minLat || 1)) * (H - 2 * pad);

  const pts = waypoints.map(w => `${toX(w.lng)},${toY(w.lat)}`).join(' ');

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible' }}>
      {/* Track */}
      <polyline points={pts} fill="none" stroke="#00e676" strokeWidth="2.5"
        strokeDasharray="6 4" strokeLinecap="round" />
      {/* Waypoint dots */}
      {waypoints.map((w, i) => (
        <circle key={i} cx={toX(w.lng)} cy={toY(w.lat)} r={i === currentIdx ? 7 : 4}
          fill={i === currentIdx ? '#ff6d00' : (i < currentIdx ? '#00e676' : '#333')}
          stroke={i === currentIdx ? '#ff6d00' : '#00e676'} strokeWidth="1.5" />
      ))}
    </svg>
  );
}

interface RouteApiResponse {
  success: boolean;
  data: {
    title: string;
    waypoints?: Array<{ lat?: unknown; lng?: unknown; placeName?: unknown; position?: unknown }>;
  };
}

export default function OnRouteClient() {
  const router = useRouter();
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [routeTitle, setRouteTitle] = useState<string | null>(null);
  const [loadingRoute, setLoadingRoute] = useState(true);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [heading, setHeading] = useState(0);
  const [pos, setPos] = useState<{ lat: number; lng: number; alt: number | null } | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [elapsedMin, setElapsedMin] = useState(0);
  const startRef = useRef(Date.now());
  const watchRef = useRef<number | null>(null);

  // Load active route from localStorage + API
  useEffect(() => {
    const routeId = localStorage.getItem('active_trail_route_id');
    if (!routeId) { setLoadingRoute(false); return; }

    fetch(`/api/routes/${routeId}`)
      .then(r => r.json())
      .then((j: RouteApiResponse) => {
        if (!j.success) return;
        setRouteTitle(j.data.title);
        const wps = j.data.waypoints;
        if (!Array.isArray(wps) || wps.length === 0) return;
        const converted: Waypoint[] = wps
          .filter(w => w.lat != null && w.lng != null)
          .map(w => ({
            lat: Number(w.lat),
            lng: Number(w.lng),
            name: (w.placeName as string | null) ?? `Точка ${Number(w.position ?? 0) + 1}`,
          }));
        if (converted.length > 0) setWaypoints(converted);
      })
      .catch(() => {})
      .finally(() => setLoadingRoute(false));
  }, []);

  // Online/offline detection
  useEffect(() => {
    setIsOnline(navigator.onLine);
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // Elapsed time
  useEffect(() => {
    const t = setInterval(() => {
      setElapsedMin(Math.floor((Date.now() - startRef.current) / 60000));
    }, 30000);
    return () => clearInterval(t);
  }, []);

  // GPS
  useEffect(() => {
    if (!navigator.geolocation) return;
    watchRef.current = navigator.geolocation.watchPosition(
      (p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude, alt: p.coords.altitude }),
      () => null,
      { enableHighAccuracy: true, maximumAge: 3000 }
    );
    return () => { if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current); };
  }, []);

  // Device orientation (compass heading)
  const handleOrientation = useCallback((e: DeviceOrientationEvent) => {
    const alpha = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
      ?? (e.alpha !== null ? (360 - e.alpha) : 0);
    setHeading(alpha);
  }, []);

  useEffect(() => {
    const evt = 'deviceorientationabsolute';
    window.addEventListener(evt, handleOrientation as EventListener);
    window.addEventListener('deviceorientation', handleOrientation as EventListener);
    return () => {
      window.removeEventListener(evt, handleOrientation as EventListener);
      window.removeEventListener('deviceorientation', handleOrientation as EventListener);
    };
  }, [handleOrientation]);

  // No-route screen
  if (loadingRoute) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center" style={{ background: '#000' }}>
        <p className="text-white/40 text-sm tracking-widest">ЗАГРУЗКА...</p>
      </div>
    );
  }

  if (waypoints.length === 0) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center px-8 text-center gap-6" style={{ background: '#000' }}>
        <div style={{ border: '2px solid #222', borderRadius: 16, padding: '40px 32px' }}>
          <p className="text-[10px] font-bold tracking-[0.4em] mb-4" style={{ color: '#444' }}>НА МАРШРУТЕ</p>
          <p className="text-white font-bold text-xl mb-2">Маршрут не выбран</p>
          <p className="text-sm mb-8" style={{ color: '#666' }}>
            Откройте маршрут в каталоге и нажмите «Начать»
          </p>
          <div className="flex flex-col gap-3">
            <Link href="/routes"
              className="flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-bold tracking-widest"
              style={{ border: '2px solid #00e676', color: '#00e676' }}>
              <Map size={18} /> ВЫБРАТЬ МАРШРУТ
            </Link>
            <Link href="/planning"
              className="flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-bold tracking-widest"
              style={{ border: '2px solid #444', color: '#666' }}>
              КОМПАС И ПЛАНИРОВАНИЕ
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const next = waypoints[currentIdx] ?? waypoints[waypoints.length - 1];
  const gpsLat = pos?.lat ?? 52.4612;
  const gpsLng = pos?.lng ?? 158.1723;
  const distKm = haversineKm(gpsLat, gpsLng, next.lat, next.lng);
  const bear = bearingDeg(gpsLat, gpsLng, next.lat, next.lng);
  const altM = pos?.alt ? Math.round(pos.alt) : 1240;
  const elapsedH = Math.floor(elapsedMin / 60);
  const elapsedM = elapsedMin % 60;

  return (
    <div className="min-h-[100dvh] flex flex-col" style={{ background: '#000', color: '#fff', fontFamily: 'monospace' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-safe pt-4 pb-3"
        style={{ borderBottom: '1px solid #1a1a1a' }}>
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="text-white/60 hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </button>
          <span className="font-bold text-white tracking-widest text-sm truncate max-w-[140px]">
            {routeTitle ?? 'VEDAR'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded text-[10px] font-bold tracking-wider"
            style={{ background: '#00e676', color: '#000' }}>
            НА МАРШРУТЕ
          </span>
          <Link href="/safety/sos"
            className="px-3 py-1 rounded text-xs font-bold tracking-widest text-white"
            style={{ background: 'var(--danger)' }}>
            SOS
          </Link>
        </div>
      </div>

      {/* Offline banner */}
      {!isOnline && (
        <div className="flex items-center justify-center gap-2 py-2 text-xs font-bold"
          style={{ background: 'var(--warning)', color: 'black' }}>
          <WifiOff size={14} />
          Офлайн-режим · Карты доступны
        </div>
      )}
      {isOnline && (
        <div className="flex items-center justify-center gap-2 py-1.5 text-[10px] font-medium"
          style={{ background: '#1a1a1a', color: '#666' }}>
          <Wifi size={12} />
          Онлайн · GPS активен
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center px-4 py-4 gap-4">

        {/* Compass */}
        <Compass heading={heading} bearing={bear} />

        {/* Waypoint info */}
        <div className="text-center">
          <p className="text-[10px] font-bold tracking-[0.3em] mb-1" style={{ color: '#555' }}>
            ТОЧКА {currentIdx + 1} ИЗ {waypoints.length}
          </p>
          <p className="text-sm font-medium" style={{ color: '#888' }}>{next.name}</p>
        </div>

        {/* Big distance */}
        <div className="text-center">
          <p className="text-[10px] font-bold tracking-[0.3em] mb-1" style={{ color: '#555' }}>
            ДО СЛЕДУЮЩЕЙ ТОЧКИ
          </p>
          <p className="font-bold leading-none" style={{ fontSize: 'clamp(3rem, 16vw, 5.5rem)', color: '#00e676' }}>
            {distKm.toFixed(1)} <span className="text-3xl">КМ</span>
          </p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 gap-4 w-full max-w-xs">
          <div className="text-center p-3 rounded-lg" style={{ border: '1px solid #1e1e1e' }}>
            <p className="text-[9px] tracking-[0.25em] mb-1" style={{ color: '#555' }}>ВЫСОТА</p>
            <p className="font-bold text-xl text-white">{altM.toLocaleString()}м
              <span className="text-[var(--success)] text-sm ml-0.5">↑</span>
            </p>
          </div>
          <div className="text-center p-3 rounded-lg" style={{ border: '1px solid #1e1e1e' }}>
            <p className="text-[9px] tracking-[0.25em] mb-1" style={{ color: '#555' }}>В ПУТИ</p>
            <p className="font-bold text-xl text-white">
              {elapsedH > 0 ? `${elapsedH}ч` : ''}{elapsedM}м
            </p>
          </div>
        </div>

        {/* Mini track */}
        <div className="w-full rounded-xl overflow-hidden p-3" style={{ background: '#0a0a0a', border: '1px solid #1a1a1a' }}>
          <p className="text-[9px] tracking-[0.3em] mb-2 text-center" style={{ color: '#444' }}>ТРЕК МАРШРУТА</p>
          <div className="flex justify-center">
            <MiniTrack waypoints={waypoints} currentIdx={currentIdx} />
          </div>
          {/* Waypoint buttons */}
          <div className="flex gap-1 mt-2 justify-center flex-wrap">
            {waypoints.map((w, i) => (
              <button key={i} onClick={() => setCurrentIdx(i)}
                className="px-2 py-0.5 rounded text-[9px] font-bold transition-all"
                style={{
                  background: i === currentIdx ? '#00e676' : '#1a1a1a',
                  color: i === currentIdx ? '#000' : '#555',
                  border: `1px solid ${i === currentIdx ? '#00e676' : '#2a2a2a'}`,
                }}>
                {i + 1}
              </button>
            ))}
          </div>
        </div>

        {/* 4 big action buttons */}
        <div className="grid grid-cols-2 gap-3 w-full">
          <Link href="/map"
            className="flex items-center justify-center gap-2 py-5 rounded-xl text-sm font-bold tracking-widest transition-all active:scale-95"
            style={{ border: '2px solid #00e676', color: '#00e676', background: 'transparent' }}>
            <Map size={20} /> КАРТА
          </Link>
          <Link href="/safety"
            className="flex items-center justify-center gap-2 py-5 rounded-xl text-sm font-bold tracking-widest transition-all active:scale-95"
            style={{ border: '2px solid #00bcd4', color: '#00bcd4', background: 'transparent' }}>
            <CloudSun size={20} /> ПОГОДА
          </Link>
          <Link href="/ai-assistant"
            className="flex items-center justify-center gap-2 py-5 rounded-xl text-sm font-bold tracking-widest transition-all active:scale-95"
            style={{ border: '2px solid #ff6d00', color: '#ff6d00', background: 'transparent' }}>
            <MessageSquare size={20} /> КУЗЬМИЧ
          </Link>
          <Link href="/safety/sos"
            className="flex items-center justify-center gap-2 py-5 rounded-xl text-sm font-bold tracking-widest transition-all active:scale-95"
            style={{ background: 'var(--danger)', color: 'white', border: '2px solid var(--danger)' }}>
            <Navigation size={20} /> SOS
          </Link>
        </div>
      </div>
    </div>
  );
}
