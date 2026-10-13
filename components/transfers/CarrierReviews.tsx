/**
 * Отзывы о перевозчике на его странице (слово владельца 13.10: «делай блок
 * отзывов но логично»; CLAUDE.md §14, миграция 1235).
 *
 * Логика видна читателю, а не только верна в коде:
 *   · под каждым отзывом — чем доказано, что автор ехал (машина под заказ,
 *     поездку подтвердил менеджер Ведара);
 *   · сводка — средняя по ВИДИМЫМ отзывам, посчитанная при чтении; отзывов
 *     нет — нет и числа, а не «0,0»;
 *   · пусто — объяснение, кто и как может оставить отзыв; не смогли
 *     прочитать — так и сказано, а не «отзывов нет».
 *
 * Компонент без хуков: страница рисуется на сервере.
 */

import { MessageSquare, ShieldCheck, Star, AlertTriangle } from 'lucide-react';
import type { CarrierReviewsBlock } from '@/lib/transfers/carrier-reviews';
import {
  CARRIER_REVIEWS_ANCHOR,
  ratingWords,
  reviewProofLine,
  reviewsCountWords,
} from '@/lib/transfers/carrier-review-rules';

function Stars({ rating, size = 'w-4 h-4' }: { rating: number; size?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`Оценка ${rating} из 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} aria-hidden className={`${size} ${i <= rating ? 'text-[var(--warning)] fill-[var(--warning)]' : 'text-[var(--text-muted)]'}`} />
      ))}
    </span>
  );
}

/**
 * Кто может оставить отзыв — одним текстом для пустого блока и для хвоста
 * списка. Кнопки «Оставить отзыв» здесь нет: без ссылки менеджера писать
 * некуда, и кнопка вела бы на страницу, которая скажет то же самое.
 */
function WhoCanReview() {
  return (
    <p className="text-sm text-[var(--text-secondary)]">
      Отзыв оставляет только тот, кто ехал: после поездки на заказанной машине менеджер Ведара присылает
      заказчику ссылку на отзыв.
    </p>
  );
}

export function CarrierReviews({ reviews }: { reviews: CarrierReviewsBlock }) {
  return (
    <section id={CARRIER_REVIEWS_ANCHOR} aria-labelledby="carrier-reviews-title" className="scroll-mt-24">
      <h2 id="carrier-reviews-title" className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-4">Отзывы</h2>

      {reviews.state === 'failed' ? (
        <p className="text-sm text-[var(--text-secondary)] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" aria-hidden />
          Не смогли загрузить отзывы — это сбой на нашей стороне, а не «отзывов нет».
        </p>
      ) : reviews.items.length === 0 ? (
        <div className="py-8 px-6 border border-dashed border-[var(--border)] rounded-lg">
          <MessageSquare className="w-7 h-7 mb-2.5 text-[var(--text-muted)]" aria-hidden />
          <p className="text-[var(--text-primary)] font-medium mb-2">Отзывов пока нет</p>
          <WhoCanReview />
        </div>
      ) : (
        <>
          {reviews.average !== null && (
            <div className="flex items-center gap-3 mb-5" data-testid="carrier-rating">
              <span className="font-playfair text-[28px] font-bold leading-none text-[var(--text-primary)]">{ratingWords(reviews.average)}</span>
              <div>
                <Stars rating={Math.round(reviews.average)} />
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  {reviewsCountWords(reviews.count)} — только от тех, кто ехал
                </p>
              </div>
            </div>
          )}
          <ul className="space-y-5">
            {reviews.items.map((r) => (
              <li key={r.id} className="pb-5 border-b border-[var(--border)] last:border-0 last:pb-0">
                <div className="flex items-start justify-between gap-4 mb-2">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: 'color-mix(in srgb, var(--accent) 15%, transparent)' }} aria-hidden>
                      <span className="text-sm font-bold text-[var(--accent)]">{r.authorName.charAt(0)}</span>
                    </div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{r.authorName}</p>
                  </div>
                  <Stars rating={r.rating} />
                </div>
                {r.comment && <p className="text-sm text-[var(--text-secondary)] leading-relaxed whitespace-pre-line">{r.comment}</p>}
                <p className="text-xs text-[var(--text-muted)] mt-2 flex items-start gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-[var(--success)] shrink-0 mt-px" aria-hidden />
                  {reviewProofLine(r)}
                </p>
              </li>
            ))}
          </ul>
          {reviews.count > reviews.items.length && (
            <p className="text-xs text-[var(--text-muted)] mt-4">
              Показаны последние {reviews.items.length} из {reviews.count}; средняя — по всем.
            </p>
          )}
          <div className="mt-6">
            <WhoCanReview />
          </div>
        </>
      )}
    </section>
  );
}
