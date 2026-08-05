'use client';

/**
 * Отзыв о туре — форма вместо нарисованной кнопки.
 *
 * Владелец 05.08: «оставить отзыв не работает». Так и было: в карточке стоял
 * `<span>`, стилизованный под кнопку, без обработчика и без ссылки. Элемент
 * выглядел как действие и не делал ничего — тот же класс, что мёртвая ссылка на
 * `/hub/tour/{id}` в фиде Авито: интерфейс обещает то, чего за ним нет.
 *
 * Правило платформы (`POST /api/reviews/tour/[tourId]`): отзыв может оставить
 * только тот, у кого есть ЗАВЕРШЁННАЯ бронь этого тура. Правило верное — оно
 * защищает от накрутки, — и врать о нём нельзя. Поэтому форма не притворяется
 * доступной всем: гостю честно сказано, что отзыв открывается после поездки, а
 * отказ сервера показывается его же словами, а не «что-то пошло не так».
 */

import { useState } from 'react';
import { PenLine, Star, Check } from 'lucide-react';

type State = 'idle' | 'form' | 'sending' | 'sent';

export default function TourReviewForm({ tourId }: { tourId: string | number }) {
  const [state, setState] = useState<State>('idle');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (rating < 1) {
      setError('Поставьте оценку от 1 до 5 звёзд');
      return;
    }
    setState('sending');
    setError(null);
    try {
      const res = await fetch(`/api/reviews/tour/${tourId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment: comment.trim() }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) {
        // Причину отказа показываем словами сервера: «отзыв только после
        // завершения тура» — это правило, а не сбой, и человек должен его
        // прочитать, а не гадать.
        setError(data.error ?? 'Не удалось отправить отзыв. Попробуйте позже.');
        setState('form');
        return;
      }
      setState('sent');
    } catch {
      setError('Нет связи с сервером. Отзыв не отправлен.');
      setState('form');
    }
  }

  if (state === 'sent') {
    return (
      <p className="inline-flex items-center gap-2 mt-4 text-sm text-[var(--success)]">
        <Check className="w-4 h-4" />
        Спасибо, отзыв отправлен — он появится после проверки.
      </p>
    );
  }

  if (state === 'idle') {
    return (
      <button
        type="button"
        onClick={() => setState('form')}
        className="inline-flex items-center gap-2 mt-4 border border-[var(--border)] rounded-xl px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
        style={{ minHeight: 44 }}
      >
        <PenLine className="w-4 h-4 text-[var(--ocean)]" />
        Оставить отзыв
      </button>
    );
  }

  return (
    <div className="mt-4 text-left max-w-md mx-auto">
      <div className="flex items-center gap-1" role="group" aria-label="Оценка">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setRating(n)}
            aria-label={`Оценка ${n} из 5`}
            aria-pressed={rating === n}
            className="p-1.5"
            style={{ minHeight: 44, minWidth: 44 }}
          >
            <Star
              className="w-6 h-6"
              style={{
                color: n <= rating ? 'var(--warning)' : 'var(--text-muted)',
                fill: n <= rating ? 'var(--warning)' : 'transparent',
              }}
            />
          </button>
        ))}
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value.slice(0, 4000))}
        placeholder="Как прошла поездка? Что стоит знать другим?"
        rows={4}
        className="ds-input w-full mt-3 resize-y"
      />

      {error && (
        <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>
      )}

      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={submit}
          disabled={state === 'sending'}
          className="ds-btn ds-btn-primary disabled:opacity-60"
          style={{ minHeight: 44 }}
        >
          {state === 'sending' ? 'Отправляем…' : 'Отправить отзыв'}
        </button>
        <button
          type="button"
          onClick={() => { setState('idle'); setError(null); }}
          className="text-sm text-[var(--text-secondary)] hover:underline"
          style={{ minHeight: 44 }}
        >
          Отмена
        </button>
      </div>

      <p className="mt-3 text-xs text-[var(--text-muted)]">
        Отзыв можно оставить после завершённой поездки — так он остаётся честным.
      </p>
    </div>
  );
}
