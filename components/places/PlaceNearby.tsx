import Link from 'next/link';
import Image from 'next/image';
import { RouteGradientPlaceholder } from '@/components/routes/RouteGradientPlaceholder';
import type { NearbyPlace } from './types';
import { LOCATION_TYPE_LABELS } from './types';

interface Props {
  nearby: NearbyPlace[];
  placeId: string;
}

export default function PlaceNearby({ nearby, placeId: _ }: Props) {
  if (!nearby.length) return null;

  return (
    <section>
      <h2
        className="mb-3 text-[19px] font-semibold text-[var(--text-primary)]"
        style={{ fontFamily: 'var(--font-playfair)' }}
      >
        Рядом
      </h2>

      {/* Horizontal scroll on mobile, grid on md+ */}
      <div
        className="flex gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-3 md:overflow-visible"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {nearby.map(n => (
          <Link
            key={n.id}
            href={`/places/${n.id}`}
            className="group w-44 flex-shrink-0 overflow-hidden rounded-lg bg-[var(--bg-card)] transition-colors md:w-auto"
          >
            {/* Thumb */}
            <div className="relative w-full bg-[var(--bg-hover)]" style={{ paddingBottom: '65%' }}>
              {n.thumbUrl ? (
                <Image
                  src={n.thumbUrl}
                  alt={n.name}
                  fill
                  className="object-cover group-hover:scale-105 transition-transform duration-300"
                  sizes="(max-width: 640px) 160px, 33vw"
                  loading="lazy"
                />
              ) : (
                /* Честный градиент по типу места — тот же, что в герое.
                   Решение владельца 2026-07-17: AI-генерации за фотографию не
                   выдаём. Но заглушка была плоским серым прямоугольником с
                   булавкой в углу, и владелец назвал это «пустыми серыми
                   квадратами»: честность должна выглядеть как решение, а не
                   как неудача загрузки. */
                <div className="absolute inset-0">
                  <RouteGradientPlaceholder
                    title={n.name}
                    locationType={n.locationType}
                    className="h-full w-full"
                    showLabel={false}
                    compact
                  />
                </div>
              )}
              {/* Distance badge */}
              <span className="absolute top-2 right-2 text-[10px] font-bold text-white bg-black/50 px-1.5 py-0.5 rounded-full">
                {n.distanceKm} км
              </span>
            </div>
            <div className="p-3">
              <p className="text-[13px] font-semibold text-[var(--text-primary)] leading-snug line-clamp-2 group-hover:text-[var(--accent)] transition-colors">
                {n.name}
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                {LOCATION_TYPE_LABELS[n.locationType ?? 'other'] ?? 'Место'}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
