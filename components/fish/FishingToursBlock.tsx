/** Блок «Туры на рыбалку» справочника рыб: /fish/[id] и /fish (20.11). */
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import { OFFER_ORDER_NOTE } from '@/lib/tours/offer-order';
import { tourPath } from '@/lib/tours/tour-url';
import type { FishingTour } from '@/lib/fish/fishing-tours';

export function FishingToursBlock({ tours }: { tours: readonly FishingTour[] }) {
  if (tours.length === 0) return null;
  return (
      <section>
        <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-4"
          style={{ fontFamily: 'var(--font-playfair)' }}>
          Туры на рыбалку
        </h2>
        <p className="-mt-2 mb-4 text-xs leading-relaxed text-[var(--text-secondary)]">{OFFER_ORDER_NOTE.ru}</p>
        <div className="space-y-3">
          {tours.map(tour => (
            <div
              key={tour.id}
              className="ds-card relative flex items-center justify-between gap-4 hover:shadow-md transition-all duration-200 group"
            >
              {/* Ссылка на тур — слоем, имя оператора — своей ссылкой поверх (13.10). */}
              <Link href={tourPath(tour)} className="absolute inset-0 z-[1] rounded-lg" aria-label={tour.title} />
              <div className="relative z-[2] pointer-events-none flex-1 min-w-0">
                <p className="font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors truncate">
                  {tour.title}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  <OperatorNameLink name={tour.operator_name} slug={tour.operator_slug} isPublic={tour.operator_public} className="pointer-events-auto" />
                  {tour.duration_hours > 0 && (
                    <> · {tour.duration_hours >= 24
                      ? `${Math.round(tour.duration_hours / 24)} дн`
                      : `${tour.duration_hours} ч`}
                    </>
                  )}
                </p>
              </div>
              <div className="relative z-[2] pointer-events-none flex items-center gap-3 flex-shrink-0">
                <span className="font-bold text-[var(--text-primary)]">
                  {tour.base_price.toLocaleString('ru-RU')} ₽
                </span>
                <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors" />
              </div>
            </div>
          ))}
        </div>
        <Link
          href="/routes?activity_type=fishing"
          className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)] hover:underline"
        >
          Все рыболовные туры <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </section>
  );
}
