'use client';

/**
 * «Отзывы» — отзывы туристов о турах оператора и ответ на них (CRM, хвосты
 * фазы 1, #2325). Роуты были (GET /api/operator/reviews, POST …/reply), а
 * экрана не было: во «Входящих» отзыв числился «ответить нельзя — экрана
 * нет». Ответ виден туристу на карточке тура под отзывом.
 *
 * Состояния не смешиваются (§4.0): «отзывов нет» говорится, только когда
 * список прочитался; не прочитался — так и сказано, с кнопкой повтора.
 */
import { useCallback, useEffect, useState } from 'react';
import { Star, Reply, Send, Pencil, Trash2, EyeOff } from 'lucide-react';

interface TourReview {
  id: number;
  tourName: string;
  userName: string | null;
  rating: number;
  comment: string | null;
  isHidden: boolean;
  operatorReply: string | null;
  createdAt: string;
}

const REPLY_MAX = 2000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readReviews(json: unknown): { reviews: TourReview[]; total: number; avg: string | null } | null {
  if (!isRecord(json) || json.success !== true || !isRecord(json.data)) return null;
  const { reviews, stats } = json.data;
  if (!Array.isArray(reviews)) return null;
  const s = isRecord(stats) ? stats : {};
  return {
    reviews: reviews as TourReview[],
    total: typeof s.totalReviews === 'number' ? s.totalReviews : reviews.length,
    avg: typeof s.avgRating === 'string' ? s.avgRating : null,
  };
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex" aria-label={`Оценка ${rating} из 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`w-3.5 h-3.5 ${i <= rating ? 'text-[var(--warning)] fill-current' : 'text-[var(--text-muted)]'}`} />
      ))}
    </span>
  );
}

function ReplyBox({ review, onSaved }: { review: TourReview; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(review.operatorReply ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(method: 'POST' | 'DELETE') {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/operator/reviews/${review.id}/reply`, {
        method,
        headers: method === 'DELETE' ? undefined : { 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify({ reply: text.trim() }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || !isRecord(json) || json.success !== true) {
        setErr(isRecord(json) && typeof json.error === 'string' ? json.error : `Ответ не сохранён (HTTP ${res.status})`);
        return;
      }
      setEditing(false);
      onSaved();
    } catch {
      setErr('Нет связи с сервером — ответ не сохранён');
    } finally {
      setBusy(false);
    }
  }

  if (review.operatorReply && !editing) {
    return (
      <div className="space-y-1.5">
        <p className="text-sm text-[var(--text-secondary)] border-l-2 border-[var(--ocean)] pl-3">
          <span className="text-[var(--text-muted)]">Ваш ответ: </span>{review.operatorReply}
        </p>
        <div className="flex gap-3 pl-3">
          <button type="button" onClick={() => { setText(review.operatorReply ?? ''); setEditing(true); }}
            className="inline-flex items-center gap-1 text-xs text-[var(--ocean)] hover:underline">
            <Pencil className="w-3 h-3" /> Изменить
          </button>
          <button type="button" disabled={busy} onClick={() => void send('DELETE')}
            className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--danger)] disabled:opacity-50">
            <Trash2 className="w-3 h-3" /> Удалить
          </button>
        </div>
        {err && <p role="alert" className="text-xs text-[var(--danger)] pl-3">{err}</p>}
      </div>
    );
  }

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1.5 text-xs text-[var(--ocean)] hover:underline">
        <Reply className="w-3.5 h-3.5" /> Ответить
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={REPLY_MAX}
        rows={3}
        placeholder="Ответ увидят все на странице тура"
        aria-label="Ответ на отзыв"
        className="ds-input w-full"
      />
      {err && <p role="alert" className="text-xs text-[var(--danger)]">{err}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || text.trim().length === 0} onClick={() => void send('POST')} className="ds-btn ds-btn-primary">
          <Send className="w-3.5 h-3.5" /> Отправить
        </button>
        <button type="button" onClick={() => { setEditing(false); setErr(null); }} className="ds-btn ds-btn-secondary">
          Отмена
        </button>
      </div>
    </div>
  );
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; reviews: TourReview[]; total: number; avg: string | null }
  | { kind: 'error'; message: string };

/** Список отзывов — одним путём и для первой загрузки, и для повтора после ответа. */
async function fetchReviews(): Promise<LoadState> {
  try {
    const res = await fetch('/api/operator/reviews?limit=50', { cache: 'no-store' });
    const json: unknown = await res.json().catch(() => null);
    const data = res.ok ? readReviews(json) : null;
    if (data) return { kind: 'ready', ...data };
    return { kind: 'error', message: isRecord(json) && typeof json.error === 'string' ? json.error : 'Не удалось загрузить отзывы' };
  } catch {
    return { kind: 'error', message: 'Нет связи с сервером — отзывы не загружены' };
  }
}

export default function OperatorReviewsClient() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [onlyUnreplied, setOnlyUnreplied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchReviews().then((next) => { if (!cancelled) setState(next); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(() => { void fetchReviews().then(setState); }, []);

  const shown = state.kind === 'ready'
    ? state.reviews.filter((r) => !onlyUnreplied || (!r.operatorReply && !r.isHidden))
    : [];
  const unreplied = state.kind === 'ready' ? state.reviews.filter((r) => !r.operatorReply && !r.isHidden).length : 0;

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center gap-2.5 flex-wrap">
        <Star className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Отзывы о турах</h1>
        {state.kind === 'ready' && (
          <span className="text-xs text-[var(--text-muted)]">
            всего {state.total}{state.avg !== null ? ` · средняя ${state.avg}` : ''} · без ответа {unreplied}
          </span>
        )}
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Ответ публикуется на странице тура под отзывом, автору приходит уведомление. Скрытые модерацией отзывы туристам не видны.
      </p>

      {state.kind === 'loading' && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="ds-skeleton h-24 rounded-lg" />)}
        </div>
      )}

      {state.kind === 'error' && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 text-center space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">{state.message}</p>
          <button type="button" onClick={() => { setState({ kind: 'loading' }); load(); }} className="ds-btn ds-btn-secondary">Повторить</button>
        </div>
      )}

      {state.kind === 'ready' && (
        <>
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" checked={onlyUnreplied} onChange={(e) => setOnlyUnreplied(e.target.checked)} />
            Только без ответа
          </label>
          {shown.length === 0 ? (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
              <p className="text-sm text-[var(--text-primary)]">{onlyUnreplied ? 'Все отзывы с ответом' : 'Отзывов пока нет'}</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {shown.map((r) => (
                <li key={r.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-xs text-[var(--text-muted)]">{r.tourName}</p>
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{r.userName ?? 'Гость'}</p>
                    </div>
                    <div className="text-right shrink-0 space-y-0.5">
                      <Stars rating={r.rating} />
                      <p className="text-xs text-[var(--text-muted)]">
                        {new Date(r.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kamchatka' })}
                      </p>
                    </div>
                  </div>
                  {r.comment && <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{r.comment}</p>}
                  {r.isHidden ? (
                    <p className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
                      <EyeOff className="w-3.5 h-3.5" /> Скрыт модерацией — на странице тура его нет
                    </p>
                  ) : (
                    <ReplyBox review={r} onSaved={load} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
