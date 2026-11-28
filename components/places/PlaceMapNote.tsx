/**
 * Блок «на карте» в разделе «Как добраться» (Сыщик 28.11, GSC: «кроноцкое озеро
 * на карте» — 11 показов на позиции 11, 0 кликов).
 *
 * Серверный компонент без состояния: текст обязан быть в первом HTML, а карта
 * (PlaceAccess) грузится без SSR. Что здесь есть, и только оно:
 *  - координата из карточки и расстояние до Петропавловска «по прямой» — то же
 *    число, что в шапке (lib/places/distance-to-city); откуда снята координата,
 *    карточка не знает, и блок этого не скрывает;
 *  - ссылка на карту Ведара с этим местом (`/map?place=`, lib/map/map-target);
 *  - одна фраза с источником — поле `mapNote` в lib/seo/place-search-meta.
 * Дорожного расстояния и цен тут нет.
 */
import Link from 'next/link';
import { distanceToCity } from '@/lib/places/distance-to-city';
import { mapPlaceHref } from '@/lib/map/map-target';
import type { PlaceSearchMeta } from '@/lib/seo/place-search-meta';

type Note = NonNullable<PlaceSearchMeta['mapNote']>;

export function PlaceMapNote({ name, lat, lng, mapRef, note }: {
  name: string;
  lat: number;
  lng: number;
  mapRef: string;
  note: Note;
}) {
  const toCity = distanceToCity(lat, lng);
  const coord = Number.isFinite(lat) && Number.isFinite(lng);
  return (
    <div className="mt-4 rounded-2xl border border-[var(--border)] p-4" data-map-note>
      <h3 className="text-base font-semibold text-[var(--text-primary)]">{name} на карте</h3>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        {coord ? <>Координата в карточке — {lat.toFixed(3)}, {lng.toFixed(3)}. </> : null}
        {toCity ? <>От Петропавловска-Камчатского — {toCity.label}. </> : null}
        Откуда снята координата, у нас не записано.{' '}
        <Link href={mapPlaceHref(mapRef)} className="text-[var(--ocean)] underline">
          Открыть место на карте Ведара
        </Link>
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        {note.text}{' '}
        <a href={note.source.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--text-muted)] underline">
          Источник: {note.source.title}
        </a>
      </p>
    </div>
  );
}
