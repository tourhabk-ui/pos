import { Tag } from 'lucide-react';
import type { TourPromotionView } from '@/lib/tours/tour-promotion';

/**
 * «Акция оператора» на карточке тура (слово владельца 17.11 «покажи»).
 *
 * Получает уже собранные слова (`promotionView`, lib/tours/tour-promotion):
 * те же, что уходят ИИ-агенту в get_tour_details. Срок проверяет сервер —
 * сюда приходят только идущие акции. Нет акций или они не прочитались —
 * блока нет.
 *
 * Вынесено в свой компонент, чтобы сторож (tests/unit/tour-promotions.test.tsx)
 * проверял блок рендером.
 */
export function TourPromotions({ promotions }: { promotions: TourPromotionView[] | null | undefined }) {
  if (!promotions || promotions.length === 0) return null;
  return (
    <section data-testid="tour-promotions" aria-label="Акция оператора">
      {promotions.map((p, i) => (
        <div key={`${p.title}-${i}`} className="ds-card p-5 border border-[var(--border)] space-y-2" style={i > 0 ? { marginTop: 12 } : undefined}>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">
            <Tag className="w-4 h-4 shrink-0" aria-hidden="true" />
            Акция оператора
          </p>
          <h2 className="text-lg font-bold text-[var(--text-primary)]">«{p.title}»</h2>
          <p className="text-sm font-medium text-[var(--text-primary)]">{p.period}</p>
          <p className="text-[15px] leading-relaxed text-[var(--text-primary)]">{p.offer}</p>
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{p.conditions}</p>
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{p.note}</p>
          <p className="text-xs text-[var(--text-muted)]">
            {p.source}
            {' — '}
            <a
              href={p.source_url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-[var(--ocean)] underline underline-offset-2 hover:no-underline"
            >
              страница акции
            </a>
          </p>
        </div>
      ))}
    </section>
  );
}
