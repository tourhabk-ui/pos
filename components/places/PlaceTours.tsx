'use client';

import Link from 'next/link';
import { Compass, ChevronRight } from 'lucide-react';
import type { PlaceTour } from './types';
import { tourPath } from '@/lib/tours/tour-url';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';

interface Props {
  tours: PlaceTour[];
}

export default function PlaceTours({ tours }: Props) {
  if (!tours.length) return null;

  return (
    <section className="space-y-3">
      <h2
        className="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2"
        style={{ fontFamily: 'var(--font-playfair)' }}
      >
        <Compass className="w-5 h-5 text-[var(--accent)]" /> Туры к этому месту
      </h2>
      <div className="space-y-2">
        {tours.map(t => (
          <div
            key={t.id}
            className="ds-card p-4 relative flex items-center justify-between gap-3 hover:border-[var(--accent)] transition-colors group"
          >
            {/* Ссылка на тур — слоем под содержимым, имя оператора — своей
                ссылкой поверх (владелец 13.10): <a> в <a> недопустим. */}
            <Link href={tourPath(t)} className="absolute inset-0 z-[1] rounded-lg" aria-label={t.title} />
            <div className="flex-1 min-w-0 relative z-[2] pointer-events-none">
              <p className="text-sm font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                {t.title}
              </p>
              <div className="flex items-center gap-3 mt-1 text-xs text-[var(--text-muted)]">
                <OperatorNameLink name={t.operatorName} slug={t.operatorSlug} isPublic={t.operatorPublic} className="pointer-events-auto" />
                {t.durationDays != null && <span>{t.durationDays} дн.</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 relative z-[2] pointer-events-none">
              <span className="text-sm font-bold text-[var(--accent)]">
                от {t.basePrice.toLocaleString('ru-RU')} ₽
              </span>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
