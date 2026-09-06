'use client';

/**
 * components/field/PointCard.tsx — карточка точки на карте, как в навигаторе.
 *
 * Владелец 05.09 на первый чип координат: «ты не понял, посмотри, как у
 * референсов навигационных это работает». У Organic Maps и OsmAnd
 * координаты не висят коробкой поверх карты: тап по любой точке ставит
 * булавку и открывает снизу карточку места — координаты (тап по числу
 * переключает формат), «скопировать», «проложить сюда», «поделиться» — и
 * путь рисуется на той же карте сразу. Своё положение открывается так же,
 * тапом по синей точке. Здесь — та же карточка на двух родах точки:
 *
 *   pin — точка, по которой ткнули: расстояние и азимут от меня, прокладка
 *         автопути по дорожному графу (линия ложится на большую карту),
 *         передача в чужой навигатор;
 *   me  — я: координаты фикса, скопировать, поделиться. Прокладывать до
 *         себя нечего.
 *
 * Карточка — стекло поверх карты (§5: слой контекста), а не непрозрачный
 * прибор: она уходит с карты по X и не несёт главной цифры навигации.
 * Форматы координат — lib/geo/format-coords, одни на экран и на буфер.
 */

import { useCallback, useEffect, useState } from 'react';
import { Copy, Check, Navigation, X } from 'lucide-react';
import NavigateTo from '@/components/shared/NavigateTo';
import { distanceM, formatCoords, type CoordFormat, type LatLng } from '@/lib/geo/format-coords';

const FORMAT_KEY = 'vedar:coord-format';

export type PointCardRouteState =
  | { phase: 'idle' }
  | { phase: 'building' }
  | { phase: 'found' }
  | { phase: 'failed'; text: string };

export interface PointCardProps {
  kind: 'pin' | 'me';
  point: LatLng;
  /** Мой фикс; null — фикса нет (тогда ни расстояния, ни прокладки). */
  me: LatLng | null;
  route: PointCardRouteState;
  onRoute: () => void;
  onClose: () => void;
}

/** Азимут от a к b, градусы 0..360. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** «8.7 км» / «640 м» — как на главной цифре экрана. */
export function distanceLabel(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${Math.round(m)} м`;
}

function readFormat(): CoordFormat {
  try { return window.localStorage.getItem(FORMAT_KEY) === 'dms' ? 'dms' : 'dd'; } catch { return 'dd'; }
}

export function PointCard({ kind, point, me, route, onRoute, onClose }: PointCardProps) {
  const [format, setFormat] = useState<CoordFormat>('dd');
  const [copied, setCopied] = useState(false);
  useEffect(() => { setFormat(readFormat()); }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const text = formatCoords(point, format);
  const toggleFormat = useCallback(() => {
    setFormat((f) => {
      const next: CoordFormat = f === 'dd' ? 'dms' : 'dd';
      try { window.localStorage.setItem(FORMAT_KEY, next); } catch { /* приватный режим — не запомнится */ }
      return next;
    });
  }, []);
  const copy = useCallback(async () => {
    try { await navigator.clipboard?.writeText(text); setCopied(true); } catch { setCopied(false); }
  }, [text]);

  const dist = kind === 'pin' && me ? distanceM(me, point) : null;
  const bearing = kind === 'pin' && me ? Math.round(bearingDeg(me, point)) : null;
  const title = kind === 'me' ? 'Я' : 'Точка на карте';

  return (
    <div className="fx-glass-dense rounded-2xl px-4 pt-3 pb-3 text-white" role="dialog" aria-label={title}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-white/70">{title}</p>
          {/* Число — кнопка: тап переключает формат, как в Organic Maps. */}
          <button type="button" onClick={toggleFormat}
            aria-label={format === 'dd' ? 'Координаты, десятичные градусы; тап — градусы, минуты, секунды' : 'Координаты, градусы, минуты, секунды; тап — десятичные'}
            className="text-base font-semibold tabular-nums text-left leading-tight mt-0.5 transition-all duration-200 active:opacity-70"
            style={{ minHeight: 32 }}>
            {text}
          </button>
          {dist != null && bearing != null && (
            <p className="text-xs text-white/70 mt-1 tabular-nums">{distanceLabel(dist)} от меня · азимут {bearing}°</p>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Закрыть карточку точки"
          className="p-2 -mr-2 -mt-1 rounded-lg transition-all duration-200 active:opacity-70" style={{ minWidth: 44, minHeight: 44 }}>
          <X className="w-5 h-5 text-white/80" />
        </button>
      </div>

      {route.phase === 'building' && <p className="text-xs text-white/70 mt-2">Ищем дорогу по нашим данным…</p>}
      {route.phase === 'found' && <p className="text-xs mt-2" style={{ color: 'var(--success)' }}>Путь на карте — синяя линия по дорожной сети.</p>}
      {route.phase === 'failed' && <p className="text-xs mt-2" style={{ color: 'var(--warning)' }}>{route.text}</p>}

      <div className="flex items-center gap-2 mt-3">
        <button type="button" onClick={() => { void copy(); }}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 rounded-lg transition-all duration-200 active:opacity-70"
          style={{ minHeight: 44, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.18)' }}>
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Скопировано' : 'Скопировать'}
        </button>
        {kind === 'pin' && (
          <button type="button" onClick={onRoute} disabled={!me || route.phase === 'building'}
            title={me ? undefined : 'Нет фикса GPS — откуда прокладывать, неизвестно'}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 rounded-lg transition-all duration-200 active:opacity-70 disabled:opacity-50"
            style={{ minHeight: 44, background: 'var(--accent)', color: '#fff' }}>
            <Navigation className="w-4 h-4" />
            Проложить сюда
          </button>
        )}
      </div>
      {/* Чужие навигаторы — тем же компонентом, что на карточке точки маршрута:
          для дороги до старта они по-прежнему лучше нас (слово владельца 11.08). */}
      <div className="mt-2">
        <NavigateTo to={{ lat: point.lat, lng: point.lng, name: title }} from={me ? { lat: me.lat, lng: me.lng, name: 'Я' } : null}
          mode="car" title={null} />
      </div>
    </div>
  );
}
