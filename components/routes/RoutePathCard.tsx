'use client';

import Link from 'next/link';
import { catalogHref } from '@/lib/routes/url-slug';
import { useWishlist, wishlistLabel, WISHLIST_LOCAL_ONLY_HINT } from '@/hooks/use-wishlist';
import { Heart, Clock, Footprints, ChevronUp, ChevronsUp, AlertTriangle, Ruler, TrendingUp } from 'lucide-react';
import type { RouteItem } from './RouteCard';
import RouteTourPriceLine from './RouteTourPriceLine';
import { PhotoCreditLink } from '@/components/media/PhotoCreditLink';

/**
 * Ступени сложности. Неизвестной нет намеренно (22.11): прежде карточка
 * подставляла «Лёгкий» и на незаписанную сложность, и на `extreme` — которого
 * в словаре не было. Не знаем — бейджа нет.
 */
const DIFFICULTY_CONFIG = {
  easy:    { label: 'Лёгкий',        color: 'var(--success)', Icon: ChevronUp },
  medium:  { label: 'Средний',       color: 'var(--warning)', Icon: ChevronsUp },
  hard:    { label: 'Сложный',       color: 'var(--danger)',  Icon: AlertTriangle },
  extreme: { label: 'Экстремальный', color: 'var(--danger)',  Icon: AlertTriangle },
} as const;

/**
 * Подписи — из единого словаря. Здесь `boat_trip` назывался «Сплав», хотя
 * сплав — это `rafting`: морская прогулка выдавалась за сплав по реке.
 */
import { activityLabel } from '@/lib/tours/labels';
import { difficultyCode } from '@/lib/routes/difficulty-scale';

function daysLabel(n: number) {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return `${n} дней`;
  if (m10 === 1) return `${n} день`;
  if (m10 >= 2 && m10 <= 4) return `${n} дня`;
  return `${n} дней`;
}

const num = (n: number, max = 1) => n.toLocaleString('ru-RU', { maximumFractionDigits: max });

/**
 * Цифры пути для карточки: длина, набор, время — только записанные (22.11).
 * Время: больше суток — днями (из duration_days, иначе из часов), меньше —
 * часами. Пометка дистанции («в одну сторону») — как на карточке маршрута.
 */
export function routeCardFacts(route: Pick<RouteItem, 'distanceKm' | 'distanceNote' | 'elevationGainM' | 'durationHours' | 'durationDays'>): Array<{ key: string; Icon: React.ElementType; text: string }> {
  const out: Array<{ key: string; Icon: React.ElementType; text: string }> = [];
  if (route.distanceKm != null && route.distanceKm > 0) {
    out.push({ key: 'km', Icon: Ruler, text: `${num(route.distanceKm)} км${route.distanceNote ? ` ${route.distanceNote}` : ''}` });
  }
  if (route.elevationGainM != null && route.elevationGainM > 0) {
    out.push({ key: 'gain', Icon: TrendingUp, text: `${num(route.elevationGainM, 0)} м` });
  }
  const days = route.durationDays != null && route.durationDays > 1 ? route.durationDays : null;
  if (days != null) {
    out.push({ key: 'time', Icon: Clock, text: daysLabel(days) });
  } else if (route.durationHours != null && route.durationHours > 0) {
    out.push({ key: 'time', Icon: Clock, text: route.durationHours >= 24 ? daysLabel(Math.ceil(route.durationHours / 24)) : `${num(route.durationHours)} ч` });
  } else if (route.durationDays === 1) {
    out.push({ key: 'time', Icon: Clock, text: daysLabel(1) });
  }
  return out;
}

export default function RoutePathCard({ route, eager = false }: { route: RouteItem; eager?: boolean }) {
  const diffKey      = difficultyCode(route.difficulty);
  const diff         = diffKey ? DIFFICULTY_CONFIG[diffKey] : null;
  const DiffIcon     = diff?.Icon ?? null;
  const actLabel     = activityLabel(route.activityType ?? route.category) || 'Маршрут';

  // imageUrl из каталога всегда разрешается: реальное фото маршрута
  // (/api/images/route/id) → подобранное фото → категорийный фолбэк
  // (lib/routes/catalog-query.ts). Раньше карточка его просто не рисовала —
  // отсюда пустые тёмные прямоугольники в каталоге.
  const photoSrc = route.imageUrl ?? null;
  const facts = routeCardFacts(route);

  // Избранное — общий хук: тело запроса, вход гостя и текст ошибки
  // живут в одном месте (диалекты карточек ломали кнопку до 09.08).
  const fav = useWishlist('route', route.id);
  return (
    <article className="group flex flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden transition-all duration-200 hover:border-[var(--accent)]/40 hover:shadow-sm">
      {/* ── Фото маршрута ─────────────────────────────────── */}
      {/* Одна пропорция у всех карточек (22.11, «по стандартам индустрии»):
          без фото — нейтральная заглушка того же размера, сетка не прыгает. */}
      <Link href={route.href ?? catalogHref(route, '/routes')} className="block relative aspect-[16/10]" data-testid={photoSrc ? undefined : 'route-card-nophoto'}>
        {photoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoSrc}
            alt={route.photoAlt || route.title}
            loading={eager ? 'eager' : 'lazy'}
            {...(eager ? { fetchPriority: 'high' as const } : {})}
            className="w-full h-full object-cover"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: 'var(--bg-hover)' }}
          >
            <Footprints className="w-8 h-8 text-[var(--text-muted)] opacity-40" aria-hidden="true" />
          </div>
        )}

        {/* Подложка снизу — читаемость бейджа поверх любого фото */}
        {photoSrc && <div className="absolute inset-x-0 bottom-0 h-14 pointer-events-none bg-gradient-to-t from-black/45 to-transparent" />}

        {/* Тип активности — glass поверх фото */}
        <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full backdrop-blur-md bg-black/40 border border-white/15 text-white">
          <Footprints className="w-3 h-3" />
          {actLabel}
        </span>

        {/* Избранное — glass поверх фото */}
        <button
          type="button"
          onClick={fav.toggle}
          aria-label={wishlistLabel(fav)}
            title={fav.localOnly ? WISHLIST_LOCAL_ONLY_HINT : undefined}
          className="absolute top-2 right-2 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 backdrop-blur-md border border-white/15"
          style={{ background: fav.on ? 'var(--accent)' : 'rgba(0,0,0,0.4)', opacity: fav.busy ? 0.5 : 1 }}
        >
          <Heart
            className="w-3.5 h-3.5 transition-all"
            style={{ color: 'white', fill: fav.on ? 'white' : 'none' }}
          />
        </button>
      </Link>

      {/* Подпись снимка тура (21.11) — отдельной строкой ВНЕ ссылки на
          маршрут: имя автора ведёт на его страницу или фотоленту. */}
      {photoSrc && route.photoCredit && (
        <p className="px-3 pt-1.5 text-[11px] leading-snug text-[var(--text-muted)] truncate" data-testid="route-card-photo-credit">
          Фото: <PhotoCreditLink credit={route.photoCredit} />
        </p>
      )}

      {/* ── Тело ──────────────────────────────────────────── */}
      {/* Карточка каталога — название и цифры пути, как в каталогах
          туристических сервисов (22.11). Пересказ описания — на странице
          маршрута: на карточке он отодвигал цифры, по которым выбирают. */}
      <Link href={route.href ?? catalogHref(route, '/routes')} className="flex flex-1 flex-col gap-2 p-3">
        <h3
          className="font-semibold text-[var(--text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--accent)] transition-colors"
          style={{ fontFamily: 'var(--font-playfair)', fontSize: '1.0625rem' }}
        >
          {route.title}
        </h3>
        {(diff && DiffIcon) || facts.length > 0 ? (
          <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap text-[13px] text-[var(--text-secondary)]" data-testid="route-card-facts">
            {diff && DiffIcon ? (
              <span
                className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ background: `color-mix(in srgb, ${diff.color} 13%, transparent)`, color: diff.color, border: `1px solid color-mix(in srgb, ${diff.color} 27%, transparent)` }}
                data-testid="route-card-difficulty"
              >
                <DiffIcon className="w-3 h-3" />
                {diff.label}
              </span>
            ) : null}
            {facts.map(({ key, Icon, text }) => (
              <span key={key} className="inline-flex items-center gap-1 tabular-nums">
                <Icon className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden="true" />
                {text}
              </span>
            ))}
          </div>
        ) : null}
        {/* Цена маршрута — из его туров (18.11 «1», lib/routes/route-tour-price). */}
        <div className="mt-auto">
          <RouteTourPriceLine price={route.tourPrice} />
        </div>
      </Link>
    </article>
  );
}
