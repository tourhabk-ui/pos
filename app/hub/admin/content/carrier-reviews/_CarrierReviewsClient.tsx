'use client';

import { useEffect, useState } from 'react';
import { Star, EyeOff, Eye, Loader2, Link2, Copy, Check, AlertTriangle } from 'lucide-react';

/**
 * Отзывы о перевозчиках — экран менеджера (миграция 1235; слово владельца
 * 13.10: «делай блок отзывов но логично»).
 *
 * Две части одной работы:
 *   1. Заявки на машину. Заявка — не поездка; состоялась ли она, знает
 *      менеджер-посредник. Он подтверждает «поездка состоялась» и получает
 *      ссылку на отзыв — показывается ОДИН раз, в базе только хэш. Отправляет
 *      её заказчику сам: телефон заказчика на этом экране для этого.
 *   2. Отзывы. Скрыть — с причиной не короче 8 символов; вернуть — без неё.
 *      Рейтинг перевозчика считается при чтении из видимых, пересчитывать
 *      нечего.
 */

type Verdict = { ok: true } | { ok: false; reason: 'no_date' | 'not_yet' | 'already_reviewed' };

interface Charter {
  lead_id: string;
  carrier_name: string;
  customer_name: string | null;
  customer_phone: string | null;
  destination: string | null;
  date_from: string | null;
  date_to: string | null;
  passengers: string | null;
  created_at: string;
  is_self: boolean;
  ride_confirmed_at: string | null;
  link_issued_at: string | null;
  link_expires_at: string | null;
  review_id: string | null;
  issue: Verdict;
}

interface Review {
  id: string;
  carrier_name: string;
  carrier_slug: string;
  author_name: string;
  rating: number;
  comment: string;
  proof_line: string;
  is_hidden: boolean;
  hidden_reason: string | null;
  created_at: string;
}

type Part<T> = { state: 'loading' } | { state: 'ok'; items: T[] } | { state: 'failed' };
type Filter = 'all' | 'visible' | 'hidden';

const BLOCKED: Record<Exclude<Verdict, { ok: true }>['reason'], string> = {
  no_date: 'в заявке нет даты выезда',
  not_yet: 'поездка ещё впереди',
  already_reviewed: 'отзыв уже оставлен',
};

function fmt(d: string | null): string {
  if (!d) return '—';
  const x = new Date(d.length === 10 ? `${d}T00:00:00Z` : d);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: d.length === 10 ? 'UTC' : undefined });
}

interface Screen { reviews: Part<Review>; charters: Part<Charter>; error: string | null }

/** Загрузка экрана без побочных эффектов: состояние меняет вызывающий, по ответу. */
async function fetchScreen(filter: Filter): Promise<Screen> {
  const failed = { state: 'failed' } as const;
  try {
    const res = await fetch(`/api/admin/carrier-reviews?filter=${filter}`);
    const d = await res.json() as {
      success?: boolean; error?: string;
      data?: { reviews: Part<Review>; charters: Part<Charter> };
    };
    if (!d.success || !d.data) return { reviews: failed, charters: failed, error: d.error ?? 'Не удалось загрузить' };
    return { reviews: d.data.reviews, charters: d.data.charters, error: null };
  } catch {
    return { reviews: failed, charters: failed, error: 'Не удалось загрузить — нет связи' };
  }
}

export default function CarrierReviewsClient() {
  const [filter, setFilter] = useState<Filter>('all');
  const [tick, setTick] = useState(0);
  const [charters, setCharters] = useState<Part<Charter>>({ state: 'loading' });
  const [reviews, setReviews] = useState<Part<Review>>({ state: 'loading' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ leadId: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchScreen(filter).then((s) => {
      if (cancelled) return;
      setCharters(s.charters);
      setReviews(s.reviews);
      setLoadError(s.error);
    });
    return () => { cancelled = true; };
  }, [filter, tick]);

  const reload = () => setTick((t) => t + 1);

  async function issue(c: Charter) {
    const again = c.link_issued_at !== null;
    if (again && !window.confirm('Выдать новую ссылку? Прежняя перестанет работать.')) return;
    setBusy(c.lead_id);
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      const res = await fetch('/api/admin/carrier-reviews/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: c.lead_id }),
      });
      const d = await res.json() as { success?: boolean; error?: string; message?: string; data?: { url: string } };
      if (d.success && d.data) {
        setIssued({ leadId: c.lead_id, url: d.data.url });
        setNotice(d.message ?? 'Ссылка выдана');
        reload();
      } else setError(d.error ?? 'Не удалось выдать ссылку');
    } catch {
      setError('Не удалось выдать ссылку — нет связи');
    }
    setBusy(null);
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError('Не удалось скопировать — выделите ссылку и скопируйте вручную');
    }
  }

  async function setHidden(r: Review, hidden: boolean) {
    let reason: string | null = null;
    if (hidden) {
      reason = window.prompt('Причина скрытия (не короче 8 символов)');
      if (reason === null) return;
    }
    setBusy(r.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/carrier-reviews/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hidden ? { hidden, reason } : { hidden }),
      });
      const d = await res.json() as { success?: boolean; message?: string; error?: string };
      if (d.success) { setNotice(d.message ?? 'Готово'); reload(); }
      else setError(d.error ?? 'Не удалось изменить отзыв');
    } catch {
      setError('Не удалось изменить отзыв — нет связи');
    }
    setBusy(null);
  }

  return (
    <div className="p-5 lg:p-6 space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Отзывы о перевозчиках</h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Отзыв оставляет только тот, кто ехал: место в поездке через Ведар — само, на следующий день; машина под
          заказ — по ссылке, которую вы выдаёте здесь, подтвердив, что поездка состоялась.
        </p>
      </div>

      {notice && <p className="text-sm text-[var(--success)]" role="status">{notice}</p>}
      {loadError && <p className="text-sm text-[var(--danger)]" role="alert">{loadError}</p>}
      {error && <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>}

      <section aria-labelledby="charters-title" className="space-y-3">
        <h2 id="charters-title" className="text-base font-semibold text-[var(--text-primary)]">Заявки на машину</h2>
        {charters.state === 'loading' ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" aria-hidden /></div>
        ) : charters.state === 'failed' ? (
          <p className="text-sm text-[var(--text-secondary)] flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-[var(--warning)]" aria-hidden /> Не смогли прочитать заявки — это сбой, а не «заявок нет».</p>
        ) : charters.items.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Заявок на машину пока нет.</p>
        ) : (
          <ul className="space-y-3">
            {charters.items.map((c) => (
              <li key={c.lead_id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">
                      {c.carrier_name}: {c.destination ?? 'направление не записано'} · {fmt(c.date_from)}{c.date_to && c.date_to !== c.date_from ? ` — ${fmt(c.date_to)}` : ''}
                    </p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      {c.customer_name ?? 'имя не записано'}{c.customer_phone ? ` · ${c.customer_phone}` : ''}{c.passengers ? ` · человек: ${c.passengers}` : ''} · заявка {fmt(c.created_at)}
                      {c.is_self && ' · ваш тестовый визит'}
                    </p>
                    <p className="text-xs mt-1 text-[var(--text-secondary)]">
                      {c.review_id ? 'Отзыв получен'
                        : c.link_issued_at ? `Поездка подтверждена ${fmt(c.ride_confirmed_at)}; ссылка выдана ${fmt(c.link_issued_at)}, действует до ${fmt(c.link_expires_at)}`
                          : 'Поездка не подтверждена'}
                    </p>
                  </div>
                  {c.issue.ok ? (
                    <button type="button" disabled={busy === c.lead_id} onClick={() => void issue(c)}
                      className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs font-semibold text-[var(--text-primary)] disabled:opacity-60"
                      style={{ minHeight: 36 }}>
                      <Link2 className="w-3.5 h-3.5" aria-hidden />
                      {c.link_issued_at ? 'Выдать новую ссылку' : 'Поездка состоялась — ссылка на отзыв'}
                    </button>
                  ) : (
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">{BLOCKED[c.issue.reason]}</span>
                  )}
                </div>
                {issued?.leadId === c.lead_id && (
                  <div className="mt-3 p-3 rounded-lg bg-[var(--bg-hover)] space-y-2">
                    <p className="text-xs text-[var(--text-secondary)]">Ссылка показана один раз — отправьте её заказчику (WhatsApp, Telegram, СМС):</p>
                    <p className="text-xs font-mono break-all text-[var(--text-primary)] select-all">{issued.url}</p>
                    <button type="button" onClick={() => void copy(issued.url)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs font-semibold text-[var(--text-primary)]"
                      style={{ minHeight: 36 }}>
                      {copied ? <><Check className="w-3.5 h-3.5" aria-hidden /> Скопировано</> : <><Copy className="w-3.5 h-3.5" aria-hidden /> Скопировать</>}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="reviews-title" className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 id="reviews-title" className="text-base font-semibold text-[var(--text-primary)]">Отзывы</h2>
          <div className="flex gap-2">
            {(['all', 'visible', 'hidden'] as Filter[]).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)}
                className={`min-h-[36px] px-3 rounded-lg text-sm ${filter === f
                  ? 'bg-[var(--accent)] text-[var(--bg-card)]'
                  : 'border border-[var(--border)] text-[var(--text-secondary)]'}`}>
                {f === 'all' ? 'Все' : f === 'visible' ? 'Видимые' : 'Скрытые'}
              </button>
            ))}
          </div>
        </div>
        {reviews.state === 'loading' ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" aria-hidden /></div>
        ) : reviews.state === 'failed' ? (
          <p className="text-sm text-[var(--text-secondary)] flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-[var(--warning)]" aria-hidden /> Не смогли прочитать отзывы — это сбой, а не «отзывов нет».</p>
        ) : reviews.items.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Отзывов нет.</p>
        ) : (
          <ul className="space-y-3">
            {reviews.items.map((r) => (
              <li key={r.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{r.carrier_name}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-2 flex-wrap">
                      {r.author_name} · {fmt(r.created_at)}
                      <span className="inline-flex items-center gap-0.5"><Star className="w-3 h-3" aria-hidden /> {r.rating}</span>
                    </p>
                  </div>
                  <button type="button" disabled={busy === r.id} onClick={() => void setHidden(r, !r.is_hidden)}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs font-semibold text-[var(--text-primary)] disabled:opacity-60">
                    {r.is_hidden ? <><Eye className="w-3.5 h-3.5" aria-hidden /> Вернуть</> : <><EyeOff className="w-3.5 h-3.5" aria-hidden /> Скрыть</>}
                  </button>
                </div>
                {r.comment && <p className="text-sm text-[var(--text-secondary)] mt-2 whitespace-pre-line">{r.comment}</p>}
                <p className="text-xs text-[var(--text-muted)] mt-2">{r.proof_line}</p>
                {r.is_hidden && <p className="text-xs text-[var(--warning)] mt-2">Скрыт: {r.hidden_reason ?? 'причина не записана'}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
