'use client';

import { useCallback, useEffect, useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { Star, MessageSquare, Loader2, AlertTriangle, Reply } from 'lucide-react';

/**
 * Отзывы гида — живой экран.
 *
 * До аудита бизнес-процессов 25.07 экран показывал три выдуманных отзыва
 * («Анна М.», «Дмитрий К.», «Елена С.») с придуманными оценками — при живом
 * GET /api/guide/reviews поверх guide_reviews. Для платформы, которая обещает
 * «не врать», нарисованные отзывы — худший вид фейка: они выглядят как
 * свидетельства реальных людей.
 *
 * Фильтры соответствуют контракту API (all/positive/negative/unreplied), а не
 * произвольной клиентской фильтрации по звёздам.
 */

interface GuideReview {
  id: string;
  touristName: string | null;
  tourTitle: string | null;
  rating: number;
  comment: string | null;
  guideReply: string | null;
  createdAt: string;
}

interface ReviewStats {
  totalReviews: number;
  avgRating: string;
  unrepliedCount: number;
}

const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all',       label: 'Все' },
  { value: 'positive',  label: 'Хорошие (4-5)' },
  { value: 'negative',  label: 'Плохие (1-2)' },
  { value: 'unreplied', label: 'Без ответа' },
];

export default function GuideReviewsClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<GuideReview[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async (nextFilter: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/guide/reviews?filter=${nextFilter}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || 'Не удалось загрузить отзывы');
        setReviews([]);
        return;
      }
      setReviews(json.data.reviews ?? []);
      setStats(json.data.stats ?? null);
    } catch {
      setError('Сеть недоступна. Отзывы не загружены.');
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(filter); }, [filter, load]);

  const avg = stats ? Number(stats.avgRating) : 0;

  return (
    <Protected roles={['guide', 'admin']}>
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-6">
          <MessageSquare className="w-6 h-6 text-[var(--accent)]" />
          <h1 className="ds-h1 flex items-center gap-2">
            <Star className="w-6 h-6 text-[var(--ocean)]" />
            Отзывы
          </h1>
        </div>

        {stats && (
          <div className="flex items-center gap-6 mb-6 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
            <div className="text-center">
              <p className="text-4xl font-bold text-[var(--text-primary)]">
                {stats.totalReviews > 0 ? avg.toFixed(1) : '—'}
              </p>
              <div className="flex items-center gap-0.5 mt-1">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star
                    key={s}
                    className={`w-4 h-4 ${s <= Math.round(avg) ? 'text-[var(--warning)] fill-[var(--warning)]' : 'text-[var(--text-muted)]'}`}
                  />
                ))}
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-1">{stats.totalReviews} отзывов</p>
            </div>
            {stats.unrepliedCount > 0 && (
              <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                <Reply className="w-5 h-5 text-[var(--ocean)]" />
                <span className="text-sm">Без ответа: {stats.unrepliedCount}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`min-h-[44px] px-3 py-2 rounded-lg text-sm transition-colors ${
                filter === f.value
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-sm text-[var(--text-primary)]">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : reviews.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-[var(--text-secondary)]">
              {filter === 'all' ? 'Отзывов пока нет' : 'Нет отзывов по этому фильтру'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {reviews.map((review) => (
              <div key={review.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      {review.touristName || 'Турист'}
                    </p>
                    {review.tourTitle && (
                      <p className="text-xs text-[var(--text-muted)]">{review.tourTitle}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <Star
                        key={s}
                        className={`w-3.5 h-3.5 ${s <= review.rating ? 'text-[var(--warning)] fill-[var(--warning)]' : 'text-[var(--text-muted)]'}`}
                      />
                    ))}
                  </div>
                </div>
                {review.comment && (
                  <p className="text-sm text-[var(--text-secondary)] mb-2">{review.comment}</p>
                )}
                {review.guideReply && (
                  <p className="text-sm text-[var(--text-secondary)] border-l-2 border-[var(--ocean)] pl-3 mb-2">
                    <span className="text-[var(--text-muted)]">Ваш ответ: </span>
                    {review.guideReply}
                  </p>
                )}
                <p className="text-xs text-[var(--text-muted)]">
                  {new Date(review.createdAt).toLocaleDateString('ru-RU')}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Protected>
  );
}
