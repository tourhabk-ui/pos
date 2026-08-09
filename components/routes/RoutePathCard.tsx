'use client';

import Link from 'next/link';
import { useWishlist } from '@/hooks/use-wishlist';
import { Heart, Clock, Footprints, ChevronUp, ChevronsUp, AlertTriangle, MapPin } from 'lucide-react';
import type { RouteItem } from './RouteCard';

const DIFFICULTY_CONFIG = {
  easy:   { label: 'Лёгкий',  color: 'var(--success)', Icon: ChevronUp },
  medium: { label: 'Средний', color: 'var(--warning)', Icon: ChevronsUp },
  hard:   { label: 'Сложный', color: 'var(--danger)',  Icon: AlertTriangle },
} as const;

/**
 * Подписи — из единого словаря. Здесь `boat_trip` назывался «Сплав», хотя
 * сплав — это `rafting`: морская прогулка выдавалась за сплав по реке.
 */
import { activityLabel } from '@/lib/tours/labels';

function daysLabel(n: number) {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return `${n} дней`;
  if (m10 === 1) return `${n} день`;
  if (m10 >= 2 && m10 <= 4) return `${n} дня`;
  return `${n} дней`;
}

export default function RoutePathCard({ route }: { route: RouteItem }) {
  const diffKey      = (route.difficulty ?? 'easy') as keyof typeof DIFFICULTY_CONFIG;
  const diff         = DIFFICULTY_CONFIG[diffKey] ?? DIFFICULTY_CONFIG.easy;
  const DiffIcon     = diff.Icon;
  const actLabel     = activityLabel(route.activityType ?? route.category) || 'Маршрут';

  // imageUrl из каталога всегда разрешается: реальное фото маршрута
  // (/api/images/route/id) → подобранное фото → категорийный фолбэк
  // (lib/routes/catalog-query.ts). Раньше карточка его просто не рисовала —
  // отсюда пустые тёмные прямоугольники в каталоге.
  const photoSrc = route.imageUrl ?? null;



  // Избранное — общий хук: тело запроса, вход гостя и текст ошибки
  // живут в одном месте (диалекты карточек ломали кнопку до 09.08).
  const fav = useWishlist('route', route.id);
  return (
    <article className="group rounded-lg border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden transition-all duration-200 hover:border-[var(--accent)]/40 hover:shadow-sm">
      {/* ── Фото маршрута ─────────────────────────────────── */}
      <Link href={`/routes/${route.id}`} className="block relative" style={{ height: 148 }}>
        {photoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoSrc}
            alt={route.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: `linear-gradient(155deg, color-mix(in srgb, ${diff.color} 26%, var(--bg-hover)) 0%, var(--bg-hover) 100%)` }}
          >
            <Footprints className="w-8 h-8 opacity-30" style={{ color: diff.color }} />
          </div>
        )}

        {/* Подложка снизу — читаемость бейджа поверх любого фото */}
        <div className="absolute inset-x-0 bottom-0 h-14 pointer-events-none bg-gradient-to-t from-black/45 to-transparent" />

        {/* Тип активности — glass поверх фото */}
        <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full backdrop-blur-md bg-black/40 border border-white/15 text-white">
          <Footprints className="w-3 h-3" />
          {actLabel}
        </span>

        {/* Избранное — glass поверх фото */}
        <button
          type="button"
          onClick={fav.toggle}
          aria-label={fav.on ? 'В избранном' : 'В избранное'}
          className="absolute top-2 right-2 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 backdrop-blur-md border border-white/15"
          style={{ background: fav.on ? 'var(--accent)' : 'rgba(0,0,0,0.4)', opacity: fav.busy ? 0.5 : 1 }}
        >
          <Heart
            className="w-3.5 h-3.5 transition-all"
            style={{ color: 'white', fill: fav.on ? 'white' : 'none' }}
          />
        </button>
      </Link>

      {/* ── Тело ──────────────────────────────────────────── */}
      <Link href={`/routes/${route.id}`} className="block p-3 space-y-1.5">
        <h3
          className="font-semibold text-[var(--text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--accent)] transition-colors"
          style={{ fontFamily: 'var(--font-playfair)', fontSize: '1rem' }}
        >
          {route.title}
        </h3>
        <p className="text-xs text-[var(--text-secondary)] line-clamp-2 leading-relaxed">
          {route.description}
        </p>
        <div className="flex items-center gap-2 flex-wrap pt-0.5">
          <span
            className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ background: `${diff.color}22`, color: diff.color, border: `1px solid ${diff.color}44` }}
          >
            <DiffIcon className="w-3 h-3" />
            {diff.label}
          </span>
          {route.durationDays != null && (
            <span className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] bg-[var(--bg-hover)] px-2 py-0.5 rounded-full">
              <Clock className="w-3 h-3" />
              {daysLabel(route.durationDays)}
            </span>
          )}
          {route.lat != null && (
            <span className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
              <MapPin className="w-3 h-3" />
              На карте
            </span>
          )}
        </div>
      </Link>
    </article>
  );
}
