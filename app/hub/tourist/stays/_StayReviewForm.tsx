'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';

/**
 * Форма отзыва о жилье для завершённой брони.
 * POST /api/accommodations/[accommodationId]/reviews.
 */

interface Props {
  accommodationId: string;
  bookingId: string;
  onDone: () => void;
}

export default function StayReviewForm({ accommodationId, bookingId, onDone }: Props) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (rating < 1) {
      setError('Поставьте оценку от 1 до 5');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/accommodations/${accommodationId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId, overallRating: rating, comment: comment.trim() || undefined }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось сохранить отзыв');
        return;
      }
      onDone();
    } catch {
      setError('Не удалось сохранить отзыв');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-2">
      <p className="text-xs font-medium text-[var(--text-secondary)]">Оставить отзыв</p>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            onClick={() => setRating(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            aria-label={`Оценка ${n}`}
            className="p-0.5"
          >
            <Star
              className="w-5 h-5 transition-colors"
              style={{
                color: n <= (hover || rating) ? 'var(--warning)' : 'var(--text-muted)',
                fill: n <= (hover || rating) ? 'var(--warning)' : 'transparent',
              }}
            />
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={e => setComment(e.target.value)}
        placeholder="Впечатления о проживании (необязательно)"
        maxLength={5000}
        rows={3}
        className="ds-input w-full text-sm resize-none"
      />
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      <button onClick={submit} disabled={busy} className="ds-btn ds-btn-primary text-xs">
        {busy ? 'Сохранение…' : 'Отправить отзыв'}
      </button>
    </div>
  );
}
