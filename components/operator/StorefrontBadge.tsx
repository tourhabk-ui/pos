/**
 * Бейдж «видит ли турист тур» — один на список туров кабинета и экран
 * «Чего не хватает» (issue 2642).
 *
 * Состояние считает `storefrontState` (lib/tours/public-visibility.ts) — рядом
 * со шлюзом каталога, по тем же флагам и с ответом самого шлюза
 * (`on_storefront`). Подпись и тон — здесь, чтобы два экрана не разошлись
 * словами: до issue 2642 список писал «Активен» по одному `is_active`, а экран
 * полноты — «Опубликован» по одному `is_published`, и оба промахивались.
 */
import { STOREFRONT_LABELS, type StorefrontState } from '@/lib/tours/public-visibility';

const TONE: Record<StorefrontState, string> = {
  on: 'bg-[var(--success)]/10 text-[var(--success)]',
  draft: 'bg-[var(--warning)]/10 text-[var(--warning)]',
  hidden: 'bg-[var(--bg-hover)] text-[var(--text-muted)]',
};

export function StorefrontBadge({ state }: { state: StorefrontState }) {
  return (
    <span className={`ds-badge shrink-0 ${TONE[state]}`}>
      {STOREFRONT_LABELS[state]}
    </span>
  );
}
