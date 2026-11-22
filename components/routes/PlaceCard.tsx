'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { catalogHref } from '@/lib/routes/url-slug';
import { useWishlist, wishlistLabel, WISHLIST_LOCAL_ONLY_HINT } from '@/hooks/use-wishlist';
import {
  Heart, MapPin, Flame, Wind, Thermometer, Droplets,
  Mountain, Waves, Anchor, TreePine, Landmark, Eye, Home, Ticket, ChevronRight, Navigation,
} from 'lucide-react';
import type { RouteItem } from './RouteCard';
import { LOCATION_TYPE_LABELS } from '@/components/places/types';
import { getElementForType, NEUTRAL_ELEMENT_COLOR } from '@/lib/stats/element-groups';
import { distanceKm } from './place-horizons';
import { useAnchor } from './useAnchor';
import { placeToursHref, placeToursLine } from '@/lib/places/place-tours-line';
import { PhotoCreditLink } from '@/components/media/PhotoCreditLink';
import { ownCardPhotoUrl } from '@/lib/routes/card-image';

/*
 * Карточка места в каталоге — как в каталогах туристических сервисов
 * (22.11, слово владельца: «перемудрили, сделай по стандартам индустрии»).
 * Пересматривает концепт «Живые окна»: погода зоны на каждой плитке (запрос
 * из каждой карточки), пеленг с градусами моноширинным шрифтом 8–10 px,
 * силуэт горизонта с бегущим свечением, медленный зум снимка, каскад
 * появления и сезон римскими цифрами. Место — существительное, без цен:
 * снимок, вид, название, сколько ехать, туры к месту. Погода и сезон — на
 * странице места, где у них есть подпись и источник.
 *
 * Туры (слово владельца 20.11) — строкой «N туров к месту», без цен и имён
 * компаний; туров нет или число не прочиталось — строки нет.
 */

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
  ethnic:     Landmark,
  rock:       MapPin,
  viewpoint:  Eye,
  settlement: Home,
  other:      MapPin,
};

export default function PlaceCard({ route, eager = false }: { route: RouteItem; eager?: boolean }) {
  const locType = route.locationType ?? 'other';
  const Icon    = LOCATION_ICONS[locType] ?? MapPin;
  const label   = LOCATION_TYPE_LABELS[locType] ?? 'Место';
  const element = getElementForType(locType);
  const elColor = element?.color ?? NEUTRAL_ELEMENT_COLOR;

  // Свой снимок — копией под карточку, тем же адресом, что у плитки маршрута
  // и подборок (ownCardPhotoUrl). Оригинал на телефоне грузился долго, и рамка
  // стояла белой снизу, пока он не докачается (владелец 22.11).
  const photoSrc = route.hasRealImage
    ? ownCardPhotoUrl(route.id)
    : (route.imageUrl ?? null);

  // Расстояние — от Петропавловска; если человек раньше разрешил геопозицию,
  // useAnchor отдаёт её. Без пеленга и градусов: их читают в поле, не в каталоге.
  const { anchor, label: anchorLabel } = useAnchor();
  const km = useMemo(() => {
    if (route.lat == null || route.lng == null) return null;
    return distanceKm(anchor, { lat: route.lat, lng: route.lng });
  }, [anchor, route.lat, route.lng]);

  const placeHref = route.href ?? catalogHref(route, '/places');
  const toursLine = placeToursLine(route.placeTours);
  const fav = useWishlist('place', route.id);

  return (
    <article className="group flex flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)] transition-all duration-200 hover:border-[var(--accent)]/40 hover:shadow-sm">
      {/* Заливка рамки — пока снимок грузится, место под ним видно как место,
          а не как белая дыра посреди карточки. */}
      <Link href={placeHref} className="relative block aspect-[4/3] overflow-hidden bg-[var(--bg-hover)]">
        {photoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoSrc}
            alt={route.photoAlt || route.title}
            loading={eager ? 'eager' : 'lazy'}
            fetchPriority={eager ? 'high' : undefined}
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ background: `color-mix(in srgb, ${elColor} 14%, var(--bg-hover))` }}
          >
            <Icon className="h-9 w-9 opacity-40" style={{ color: elColor }} aria-hidden="true" />
          </div>
        )}
        <button
          type="button"
          onClick={fav.toggle}
          aria-label={wishlistLabel(fav)}
          title={fav.localOnly ? WISHLIST_LOCAL_ONLY_HINT : undefined}
          className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full border border-white/15 backdrop-blur-md transition-all duration-200"
          style={{ background: fav.on ? 'var(--accent)' : 'rgba(0,0,0,0.4)', opacity: fav.busy ? 0.6 : 1 }}
        >
          <Heart className="h-4 w-4" style={{ color: 'white', fill: fav.on ? 'white' : 'none' }} />
        </button>
      </Link>

      {/* Подпись снимка тура (21.11) — ВНЕ ссылки на место: имя автора ведёт
          на страницу партнёра или фотоленту. */}
      {photoSrc && route.photoCredit && (
        <p className="px-3 pt-1.5 text-[11px] leading-snug text-[var(--text-muted)] truncate" data-testid="place-card-photo-credit">
          Фото: <PhotoCreditLink credit={route.photoCredit} />
        </p>
      )}

      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={element?.href ?? '/routes?kind=place'}
            className="text-xs font-semibold transition-opacity duration-200 hover:opacity-80"
            style={{ color: elColor }}
          >
            {label}
          </Link>
          {/* Только закрытие. TRUE в is_open — умолчание у всех мест: «никто
              не закрыл», а не «проверили — открыто» (15.10, §0). */}
          {route.isOpen === false && (
            <span className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
              Закрыто
            </span>
          )}
        </div>
        <Link href={placeHref} className="block">
          <h3
            className="line-clamp-2 font-semibold leading-snug text-[var(--text-primary)] transition-colors group-hover:text-[var(--accent)]"
            style={{ fontFamily: 'var(--font-playfair)', fontSize: '1.0625rem' }}
          >
            {route.title}
          </h3>
        </Link>
        {km != null && (
          <p className="inline-flex items-center gap-1 text-[13px] text-[var(--text-secondary)] tabular-nums" data-testid="place-card-distance">
            <Navigation className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden="true" />
            {km} км {anchorLabel}
          </p>
        )}

        {/* Туры к месту — факт и ссылка на блок туров страницы места. */}
        {toursLine && (
          <Link
            href={placeToursHref(placeHref)}
            className="mt-auto flex items-center gap-1.5 border-t border-[var(--border)] pt-2 text-[13px] font-semibold text-[var(--ocean)] transition-colors duration-200 hover:text-[var(--accent)]"
            style={{ minHeight: 44 }}
          >
            <Ticket className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{toursLine}</span>
            <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </Link>
        )}
      </div>
    </article>
  );
}
