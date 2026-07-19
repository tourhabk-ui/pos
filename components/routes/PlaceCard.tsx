'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  Heart, MapPin, Flame, Wind, Thermometer, Droplets,
  Mountain, Waves, Anchor, TreePine, Landmark, Eye, Home, Trash2,
} from 'lucide-react';
import type { RouteItem } from './RouteCard';
import { LOCATION_TYPE_LABELS } from '@/components/places/types';
import { getElementForType, NEUTRAL_ELEMENT_COLOR } from '@/lib/stats/element-groups';
import { horizonPath, closedHorizon, bearingDeg, distanceKm, rumb16, seasonRoman } from './place-horizons';
import { useAnchor } from './useAnchor';

// Концепт Ω «Живые окна» (утверждён владельцем): место — существительное,
// без цен и офферов. Кромка фото — силуэт горизонта по типу места, под
// именем — честный пеленг и дистанция от якоря (геолокация — только по
// тапу по прибору). Цвета — канон стихий lib/stats/element-groups.

const LOCATION_ICONS: Record<string, React.ElementType> = {
  volcano:    Flame,
  geyser:     Wind,
  hot_spring: Thermometer,
  thermal:    Thermometer,
  lake:       Droplets,
  mountain:   Mountain,
  river:      Waves,
  bay:        Anchor,
  beach:      Waves,
  forest:     TreePine,
  museum:     Landmark,
  historical: Landmark,
  rock:       MapPin,
  viewpoint:  Eye,
  settlement: Home,
  other:      MapPin,
};

const MONO = "'JetBrains Mono', ui-monospace, monospace";

// Каскад появления и чёт/нечет кен-бёрнса — из порядка монтирования
let mountCounter = 0;

export default function PlaceCard({ route }: { route: RouteItem }) {
  const locType = route.locationType ?? 'other';
  const Icon    = LOCATION_ICONS[locType] ?? MapPin;
  const label   = LOCATION_TYPE_LABELS[locType] ?? 'Место';

  const element  = getElementForType(locType);
  const elColor  = element?.color ?? NEUTRAL_ELEMENT_COLOR;
  const hzOpen   = horizonPath();
  const hzClosed = closedHorizon(hzOpen);

  const seq = useRef(-1);
  if (seq.current < 0) seq.current = mountCounter++;

  const photoSrc = route.hasRealImage
    ? `/api/images/route/${route.id}`
    : (route.imageUrl ?? null);

  // Прибор: пеленг и дистанция от якоря (ПК → по тапу — позиция телефона)
  const { anchor, label: anchorLabel, requestGeo } = useAnchor();
  const inst = useMemo(() => {
    if (route.lat == null || route.lng == null) return null;
    const place = { lat: route.lat, lng: route.lng };
    const brg = bearingDeg(anchor, place);
    return { km: distanceKm(anchor, place), brg, rumb: rumb16(brg) };
  }, [anchor, route.lat, route.lng]);

  const season = seasonRoman(route.bestMonths);

  // Каскад появления
  const [visible, setVisible] = useState(false);
  const artRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = artRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); io.disconnect(); }
    }, { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const [liked,  setLiked]  = useState(false);
  const [liking, setLiking] = useState(false);
  const [popped, setPopped] = useState(false);

  // Админ-удаление места прямо с витрины. isAdmin определяем из localStorage
  // (user_roles пишет AuthContext) — без зависимости от AuthProvider, чтобы
  // публичная карточка не падала вне контекста.
  const [isAdmin,  setIsAdmin]  = useState(false);
  const [removed,  setRemoved]  = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    try {
      const roles = JSON.parse(localStorage.getItem('user_roles') || '[]');
      setIsAdmin(Array.isArray(roles) && roles.includes('admin'));
    } catch { /* гость — кнопки нет */ }
  }, []);

  const handleDelete = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (deleting) return;
    if (!window.confirm(`Удалить место «${route.title}»? Действие необратимо.`)) return;
    setDeleting(true);
    try {
      let token: string | undefined;
      try { token = JSON.parse(localStorage.getItem('user') || 'null')?.token; } catch { /* cookie-сессия */ }
      const res = await fetch(`/api/admin/places/${route.id}?force=true`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) { setRemoved(true); return; }
      const data = await res.json().catch(() => ({}));
      window.alert(data?.error || `Не удалось удалить (HTTP ${res.status})`);
    } catch {
      window.alert('Сеть недоступна, попробуйте ещё раз');
    } finally {
      setDeleting(false);
    }
  }, [deleting, route.id, route.title]);

  const handleFavorite = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (liking || liked) return;
    setLiking(true);
    setPopped(true);
    try { navigator.vibrate?.(12); } catch { /* без вибромотора */ }
    try {
      const res = await fetch('/api/tourist/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_type: 'place', item_id: route.id, title: route.title }),
      });
      if (res.ok) setLiked(true);
      else if (res.status === 401) {
        window.location.href = '/auth/signin?redirect=' + encodeURIComponent(window.location.pathname);
      }
    } catch { /* silence */ }
    finally { setLiking(false); }
  }, [liking, liked, route.id, route.title]);

  const handleInstTap = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    requestGeo();
  }, [requestGeo]);

  if (removed) return null;

  return (
    <article
      ref={artRef}
      className={`pc group relative overflow-hidden ${visible ? 'pc-in' : ''}`}
      style={{
        borderRadius: 12,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        transitionDelay: visible ? `${(seq.current % 6) * 95}ms` : '0ms',
        ['--el' as string]: elColor,
      }}
    >
      {/* ── Админ: удалить место с витрины (поверх .sky) ──── */}
      {isAdmin && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          aria-label="Удалить место"
          title="Удалить место"
          className="absolute top-2 left-2 z-20 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200"
          style={{ background: 'var(--danger)', opacity: deleting ? 0.5 : 0.92 }}
        >
          <Trash2 className="w-4 h-4 text-white" />
        </button>
      )}

      {/* ── Небо: фото/градиент + вырубка-горизонт ──────── */}
      <Link href={`/places/${route.id}`} className="block">
        <div className="pc-sky relative overflow-hidden" style={{ height: 132 }}>
          {photoSrc ? (
            <img
              src={photoSrc}
              alt={route.title}
              loading="lazy"
              className={`pc-img w-full h-full object-cover ${seq.current % 2 ? 'pc-kb-odd' : 'pc-kb-even'}`}
            />
          ) : (
            <div
              className="w-full h-full flex items-start justify-end p-2"
              style={{
                background: `linear-gradient(160deg, color-mix(in srgb, ${elColor} 30%, #10151c) 0%, color-mix(in srgb, ${elColor} 10%, #0b0f14) 100%)`,
              }}
            >
              <Icon className="w-5 h-5 text-white opacity-25" />
            </div>
          )}

          {/* Мягкая подсветка цветом стихии снизу фото — цвет несёт различие */}
          <div
            className="absolute inset-x-0 bottom-0 pointer-events-none"
            style={{
              height: '58%',
              background: `linear-gradient(to top, color-mix(in srgb, ${elColor} 38%, transparent), transparent)`,
            }}
          />

          {/* Кромка: заливка фоном карточки + самообрисовка дуги цветом стихии */}
          <svg
            className="absolute bottom-0 left-0 w-full"
            style={{ height: 46, display: 'block' }}
            viewBox="0 0 200 46"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={hzClosed} fill="var(--bg-card)" />
            <path
              d={hzOpen}
              className={visible ? 'pc-hz-draw' : ''}
              pathLength={1}
              fill="none"
              stroke={elColor}
              strokeOpacity={0.9}
              strokeWidth={2.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Сердце */}
          <button
            type="button"
            onClick={handleFavorite}
            aria-label={liked ? 'В избранном' : 'В избранное'}
            className={`pc-hrt absolute top-2 right-2 z-10 w-8 h-8 rounded-full flex items-center justify-center ${popped ? 'pc-hrt-pop' : ''}`}
            onAnimationEnd={() => setPopped(false)}
            style={{ background: liked ? 'var(--accent)' : 'rgba(0,0,0,0.45)', opacity: liking ? 0.6 : 1 }}
          >
            <Heart
              className="w-3.5 h-3.5"
              style={{ color: 'white', fill: liked ? 'white' : 'none' }}
            />
          </button>
        </div>
      </Link>

      {/* ── Тело ────────────────────────────────────────── */}
      <div className="px-3 pb-3 pt-0.5">
        <Link
          href={element?.href ?? '/routes?kind=place'}
          className="inline-block text-[9px] font-semibold uppercase"
          style={{ color: elColor, letterSpacing: '0.2em' }}
        >
          {label}
        </Link>
        <Link href={`/places/${route.id}`} className="block">
          <b
            className="block text-[var(--text-primary)] line-clamp-2 group-hover:text-[var(--accent)] transition-colors"
            style={{ fontFamily: 'var(--font-playfair)', fontSize: 14, lineHeight: 1.22, fontWeight: 600 }}
          >
            {route.title}
          </b>
        </Link>

        {/* Прибор: пеленг + дистанция; тап — предложить точность (геолокация) */}
        {inst && (
          <div
            className="pc-inst mt-2 pt-2 flex items-center gap-2"
            style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
            onClick={handleInstTap}
            title="Уточнить от вашей позиции"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10.5" fill="none" stroke="var(--border)" strokeWidth="1" />
              <g style={{ transform: `rotate(${inst.brg}deg)`, transformOrigin: '12px 12px', transition: 'transform .5s ease' }}>
                <path d="M12,4.5 L14.2,13 L12,11.4 L9.8,13 Z" fill={elColor} />
              </g>
            </svg>
            <span className="min-w-0" style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-secondary)' }}>
              <b style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{inst.km} км</b>
              {' '}{inst.rumb} · {Math.round(inst.brg)}°
              <span className="block" style={{ fontSize: 8, color: 'var(--text-muted)' }}>{anchorLabel}</span>
            </span>
            {season && (
              <span className="ml-auto" style={{ fontFamily: MONO, fontSize: 8, color: 'var(--text-muted)' }}>
                {season}
              </span>
            )}
          </div>
        )}
      </div>

      <style jsx>{`
        .pc:hover { border-color: color-mix(in srgb, var(--el) 45%, var(--border)); }
        @media (prefers-reduced-motion: no-preference) {
          .pc { opacity: 0; transform: translateY(14px); transition: opacity .6s ease, transform .6s ease, border-color .2s ease; }
          .pc.pc-in { opacity: 1; transform: translateY(0); }
          .pc:active { transform: scale(.975); }
          .pc-kb-even { animation: pc-kb-a 28s ease-in-out infinite alternate; }
          .pc-kb-odd  { animation: pc-kb-b 34s ease-in-out infinite alternate; }
          @keyframes pc-kb-a { from { transform: scale(1) translateX(0); } to { transform: scale(1.09) translateX(-2.5%); } }
          @keyframes pc-kb-b { from { transform: scale(1.09) translateX(2%); } to { transform: scale(1) translateX(0); } }
          .pc-hz-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: pc-draw 1.9s ease-out forwards; }
          @keyframes pc-draw { to { stroke-dashoffset: 0; } }
          .pc-hrt-pop { animation: pc-pop .45s cubic-bezier(.3,1.6,.5,1); }
          @keyframes pc-pop { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }
        }
      `}</style>
    </article>
  );
}
