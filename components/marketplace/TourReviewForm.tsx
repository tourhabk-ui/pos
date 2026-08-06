'use client';

/**
 * Отзыв о туре — форма вместо нарисованной кнопки.
 *
 * Владелец 05.08: «оставить отзыв не работает». Так и было: в карточке стоял
 * `<span>`, стилизованный под кнопку, без обработчика и без ссылки.
 *
 * 06.08 — второй слой того же «не работает»: форма писала в старую таблицу
 * reviews (tour_id UUID), а карточка читает operator_tour_reviews (BIGINT) —
 * отправка падала всегда, а прошла бы — отзыв никто бы не увидел. Теперь API
 * пишет в живую таблицу, и появились фото (владелец: «нет возможности
 * загрузить фото»): до 3 снимков, загрузка сразу при выборе, гейт тот же —
 * только после завершённой поездки.
 *
 * Правило платформы (`POST /api/reviews/tour/[tourId]`): отзыв может оставить
 * только тот, у кого есть ЗАВЕРШЁННАЯ бронь этого тура. Правило верное — оно
 * защищает от накрутки, — и врать о нём нельзя: отказ сервера показывается
 * его же словами, а не «что-то пошло не так».
 */

import { useRef, useState } from 'react';
import { PenLine, Star, Check, Camera, X, Loader2 } from 'lucide-react';

type State = 'idle' | 'form' | 'sending' | 'sent';

const MAX_PHOTOS = 3;

export default function TourReviewForm({ tourId }: { tourId: string | number }) {
  const [state, setState] = useState<State>('idle');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function uploadPhoto(file: File) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('tour_id', String(tourId));
      const res = await fetch('/api/reviews/photo', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
      if (!res.ok || !data.ok || !data.url) {
        setError(data.error ?? 'Не удалось загрузить фото');
        return;
      }
      setPhotos(p => (p.includes(data.url!) ? p : [...p, data.url!]).slice(0, MAX_PHOTOS));
    } catch {
      setError('Нет связи с сервером. Фото не загружено.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

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
        body: JSON.stringify({ rating, comment: comment.trim(), photos }),
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
        Спасибо, отзыв опубликован — обновите страницу, чтобы его увидеть.
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

      {/* Фото: до 3, загружаются сразу при выборе */}
      <div className="mt-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); }}
        />
        {photos.length > 0 && (
          <div className="flex gap-2 mb-2">
            {photos.map((url) => (
              <div key={url} className="relative w-16 h-16 rounded-lg overflow-hidden bg-[var(--bg-hover)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="Фото к отзыву" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => setPhotos(p => p.filter(u => u !== url))}
                  aria-label="Убрать фото"
                  className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/55 text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {photos.length < MAX_PHOTOS && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 text-sm text-[var(--ocean)] hover:underline disabled:opacity-60"
            style={{ minHeight: 44 }}
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
            {uploading ? 'Загружаем фото…' : `Добавить фото (до ${MAX_PHOTOS})`}
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>
      )}

      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={submit}
          disabled={state === 'sending' || uploading}
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
