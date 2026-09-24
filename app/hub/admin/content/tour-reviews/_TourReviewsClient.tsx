'use client';

import { useCallback, useEffect, useState } from 'react';
import { Star, EyeOff, Eye, Loader2, Image as ImageIcon } from 'lucide-react';

interface Row {
  id: string;
  tour_id: string;
  tour_title: string;
  author_name: string;
  rating: number;
  comment: string;
  photo_count: number;
  is_hidden: boolean;
  hidden_reason: string | null;
  created_at: string;
}

type Filter = 'all' | 'visible' | 'hidden';

/**
 * Модерация отзывов о турах (operator_tour_reviews). Скрытие — с причиной;
 * эко за отзыв и фото списываются при скрытии и возвращаются при возврате
 * (решение владельца 24.09).
 */
export default function TourReviewsClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tour-reviews?filter=${filter}`);
      const d = await res.json() as { success?: boolean; data?: Row[]; error?: string };
      if (d.success && d.data) setRows(d.data);
      else setError(d.error ?? 'Не удалось загрузить отзывы');
    } catch {
      setError('Не удалось загрузить отзывы — нет связи');
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  async function setHidden(r: Row, hidden: boolean) {
    let reason: string | null = null;
    if (hidden) {
      reason = window.prompt('Причина скрытия (не короче 8 символов). Эко за отзыв будут списаны.');
      if (reason === null) return;
    }
    setBusyId(r.id);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tour-reviews/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hidden ? { hidden, reason } : { hidden }),
      });
      const d = await res.json() as { success?: boolean; message?: string; error?: string };
      if (d.success) { setNotice(d.message ?? 'Готово'); await load(); }
      else setError(d.error ?? 'Не удалось изменить отзыв');
    } catch {
      setError('Не удалось изменить отзыв — нет связи');
    }
    setBusyId(null);
  }

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Отзывы о турах</h1>
        <div className="flex gap-2">
          {(['all', 'visible', 'hidden'] as Filter[]).map(f => (
            <button key={f} type="button" onClick={() => setFilter(f)}
              className={`min-h-[36px] px-3 rounded-lg text-sm ${filter === f
                ? 'bg-[var(--accent)] text-[var(--bg-card)]'
                : 'border border-[var(--border)] text-[var(--text-secondary)]'}`}>
              {f === 'all' ? 'Все' : f === 'visible' ? 'Видимые' : 'Скрытые'}
            </button>
          ))}
        </div>
      </div>

      {notice && <p className="text-sm text-[var(--success)]">{notice}</p>}
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" /></div>
      ) : rows.length === 0 && !error ? (
        <p className="text-sm text-[var(--text-muted)] py-8 text-center">Отзывов нет</p>
      ) : (
        <div className="space-y-3">
          {rows.map(r => (
            <div key={r.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{r.tour_title}</p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-2">
                    {r.author_name} · {new Date(r.created_at).toLocaleDateString('ru-RU')}
                    <span className="inline-flex items-center gap-0.5"><Star className="w-3 h-3" /> {r.rating}</span>
                    {r.photo_count > 0 && <span className="inline-flex items-center gap-0.5"><ImageIcon className="w-3 h-3" /> {r.photo_count}</span>}
                  </p>
                </div>
                <button type="button" disabled={busyId === r.id} onClick={() => setHidden(r, !r.is_hidden)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs font-semibold text-[var(--text-primary)] disabled:opacity-60">
                  {r.is_hidden ? <><Eye className="w-3.5 h-3.5" /> Вернуть</> : <><EyeOff className="w-3.5 h-3.5" /> Скрыть</>}
                </button>
              </div>
              <p className="text-sm text-[var(--text-secondary)] mt-2 whitespace-pre-line">{r.comment}</p>
              {r.is_hidden && (
                <p className="text-xs text-[var(--warning)] mt-2">Скрыт: {r.hidden_reason ?? 'причина не записана'}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
