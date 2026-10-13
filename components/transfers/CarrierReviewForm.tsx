'use client';

/**
 * Форма отзыва о перевозчике (миграция 1235; слово владельца 13.10: «делай
 * блок отзывов но логично»). Доказательство поездки одно — ключ в адресе
 * (#…) из ссылки менеджера Ведара по заявке на машину: сначала спрашиваем,
 * что это за поездка (или почему ссылка не годится), потом подпись, оценка и
 * текст. Аккаунт не нужен. Без ключа формы нет — только правило словами:
 * машину заказывают целиком, мест в поездках нет (владелец 13.10).
 *
 * Отказы сервера показываются его словами: «ссылка устарела» — это правило,
 * а не сбой, и человек должен его прочитать.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Loader2, Star, AlertTriangle } from 'lucide-react';
import {
  CARRIER_REVIEWS_ANCHOR,
  carrierReviewPath,
  isInviteKeyShape,
  rideDateWords,
} from '@/lib/transfers/carrier-review-rules';
import { carrierPagePath } from '@/lib/transfers/charter-format';

type Basis =
  | { kind: 'checking' }
  | { kind: 'link'; key: string; destination: string | null; dateFrom: string | null; dateTo: string | null }
  | { kind: 'no_link' }
  | { kind: 'problem'; message: string };

type Sending = 'idle' | 'sending' | 'sent';

export function CarrierReviewForm({ carrierSlug, carrierName }: {
  carrierSlug: string;
  carrierName: string;
}) {
  const [basis, setBasis] = useState<Basis>({ kind: 'checking' });
  const [authorName, setAuthorName] = useState('');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState<Sending>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = window.location.hash.slice(1);
    (async () => {
      try {
        if (key && isInviteKeyShape(key)) {
          const res = await fetch('/api/carrier-reviews/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ carrier: carrierSlug, key }),
          });
          const body = await res.json().catch(() => null) as
            | { success?: boolean; error?: string; data?: { state: string; message?: string; destination?: string | null; date_from?: string | null; date_to?: string | null } }
            | null;
          if (cancelled) return;
          if (!res.ok || !body?.success || !body.data) {
            setBasis({ kind: 'problem', message: body?.error ?? 'Не смогли проверить ссылку — попробуйте позже.' });
          } else if (body.data.state !== 'ok') {
            setBasis({ kind: 'problem', message: body.data.message ?? 'Ссылка не годится.' });
          } else {
            setBasis({ kind: 'link', key, destination: body.data.destination ?? null, dateFrom: body.data.date_from ?? null, dateTo: body.data.date_to ?? null });
          }
          return;
        }
        setBasis(key
          ? { kind: 'problem', message: 'Ссылка на отзыв не распознана — откройте её из сообщения целиком.' }
          : { kind: 'no_link' });
      } catch {
        if (!cancelled) setBasis({ kind: 'problem', message: 'Нет связи с сервером. Проверьте подключение и обновите страницу.' });
      }
    })();
    return () => { cancelled = true; };
  }, [carrierSlug]);

  async function submit() {
    if (rating < 1) { setError('Поставьте оценку от 1 до 5 звёзд'); return; }
    if (basis.kind !== 'link') return;
    const payload = { via: 'link', carrier: carrierSlug, key: basis.key, author_name: authorName, rating, comment: comment.trim() };
    setSending('sending');
    setError(null);
    try {
      const res = await fetch('/api/carrier-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!res.ok || !body?.success) {
        setError(body?.error ?? 'Не удалось отправить отзыв. Попробуйте позже.');
        setSending('idle');
        return;
      }
      // Ключ погашен — убираем его из адресной строки, чтобы он не уехал дальше.
      window.history.replaceState(null, '', carrierReviewPath(carrierSlug));
      setSending('sent');
    } catch {
      setError('Нет связи с сервером. Отзыв не отправлен.');
      setSending('idle');
    }
  }

  const back = `${carrierPagePath(carrierSlug)}#${CARRIER_REVIEWS_ANCHOR}`;

  if (sending === 'sent') {
    return (
      <div className="ds-card p-5" role="status">
        <p className="inline-flex items-center gap-2 text-[var(--success)] font-medium">
          <Check className="w-5 h-5" aria-hidden /> Спасибо — отзыв опубликован.
        </p>
        <p className="mt-3"><Link href={back} className="text-[var(--ocean)] hover:underline">Вернуться к перевозчику «{carrierName}»</Link></p>
      </div>
    );
  }

  if (basis.kind === 'checking') {
    return (
      <p className="text-sm text-[var(--text-muted)] inline-flex items-center gap-2" role="status">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Проверяем, о какой поездке отзыв…
      </p>
    );
  }

  if (basis.kind === 'problem') {
    return (
      <div className="ds-card p-5">
        <p className="text-sm text-[var(--text-secondary)] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" aria-hidden /> {basis.message}
        </p>
      </div>
    );
  }

  if (basis.kind === 'no_link') {
    return (
      <div className="ds-card p-5 space-y-3 text-sm text-[var(--text-secondary)]" data-testid="review-no-link">
        <p>
          Отзыв о «{carrierName}» оставляет тот, кто ехал. После поездки на заказанной машине менеджер Ведара
          присылает заказчику ссылку на отзыв — откройте её из сообщения целиком.
        </p>
        <p>Ссылки нет, а поездка была — напишите менеджеру Ведара: он сверит заявку и пришлёт её.</p>
      </div>
    );
  }

  return (
    <div className="ds-card p-5 space-y-4">
      <p className="text-sm text-[var(--text-secondary)]">
        Поездка: машина под заказ{basis.destination ? ` — ${basis.destination}` : ''}
        {basis.dateFrom ? `, ${rideDateWords(basis.dateFrom)}${basis.dateTo && basis.dateTo !== basis.dateFrom ? ` — ${rideDateWords(basis.dateTo)}` : ''}` : ''}.
        Менеджер Ведара подтвердил, что она состоялась.
      </p>

      <div>
        <label htmlFor="review-author" className="ds-label">Подпись под отзывом</label>
        <input
          id="review-author"
          className="ds-input w-full mt-1"
          value={authorName}
          onChange={(e) => setAuthorName(e.target.value.slice(0, 60))}
          autoComplete="given-name"
          placeholder="Например, Анна"
        />
        <p className="text-xs text-[var(--text-muted)] mt-1">Отзыв увидят все: на сайте будет имя и первая буква фамилии, если вы её напишете.</p>
      </div>

      <div>
        <p className="ds-label mb-1" id="review-rating-label">Оценка</p>
        <div className="flex items-center gap-1" role="group" aria-labelledby="review-rating-label">
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
                aria-hidden
                style={{ color: n <= rating ? 'var(--warning)' : 'var(--text-muted)', fill: n <= rating ? 'var(--warning)' : 'transparent' }}
              />
            </button>
          ))}
        </div>
      </div>

      <div>
        <label htmlFor="review-comment" className="ds-label">Как прошла поездка</label>
        <textarea
          id="review-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, 4000))}
          placeholder="Машина, водитель, дорога, вовремя ли забрали — что стоит знать другим?"
          rows={5}
          className="ds-input w-full mt-1 resize-y"
        />
      </div>

      {error && <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={sending === 'sending'}
        className="ds-btn ds-btn-primary inline-flex items-center gap-2 disabled:opacity-60"
        style={{ minHeight: 44 }}
      >
        {sending === 'sending' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />} Опубликовать отзыв
      </button>
    </div>
  );
}
