'use client';

/**
 * Форма отзыва о перевозчике (миграция 1235; слово владельца 13.10: «делай
 * блок отзывов но логично»). Два пути — два доказательства поездки:
 *
 *   · ключ в адресе (#…) — ссылка от менеджера Ведара по заявке на машину:
 *     сначала спрашиваем, что это за поездка (или почему ссылка не годится),
 *     потом подпись, оценка и текст. Аккаунт не нужен;
 *   · без ключа — места в поездках, заказанные через Ведар: нужен вход,
 *     список берётся с сервера, выбрать можно только подходящую поездку.
 *
 * Отказы сервера показываются его словами: «отзыв — на следующий день после
 * поездки» — это правило, а не сбой, и человек должен его прочитать.
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

interface Seat { seatBookingId: string; date: string; from: string; to: string }

type Basis =
  | { kind: 'checking' }
  | { kind: 'link'; key: string; destination: string | null; dateFrom: string | null; dateTo: string | null }
  | { kind: 'seats'; seats: Seat[] }
  | { kind: 'login' }
  | { kind: 'problem'; message: string };

type Sending = 'idle' | 'sending' | 'sent';

export function CarrierReviewForm({ carrierSlug, carrierName, initialSeat }: {
  carrierSlug: string;
  carrierName: string;
  initialSeat?: string;
}) {
  const [basis, setBasis] = useState<Basis>({ kind: 'checking' });
  const [seatId, setSeatId] = useState<string | null>(null);
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
        if (key) {
          setBasis({ kind: 'problem', message: 'Ссылка на отзыв не распознана — откройте её из сообщения целиком.' });
          return;
        }
        const res = await fetch(`/api/carrier-reviews/eligible?carrier=${encodeURIComponent(carrierSlug)}`, { credentials: 'include' });
        if (cancelled) return;
        if (res.status === 401) { setBasis({ kind: 'login' }); return; }
        const body = await res.json().catch(() => null) as { success?: boolean; error?: string; data?: { seats: Seat[] } } | null;
        if (cancelled) return;
        if (!res.ok || !body?.success || !body.data) {
          setBasis({ kind: 'problem', message: body?.error ?? 'Не смогли проверить ваши поездки — попробуйте позже.' });
          return;
        }
        const seats = body.data.seats;
        setBasis({ kind: 'seats', seats });
        setSeatId(seats.find((s) => s.seatBookingId === initialSeat)?.seatBookingId ?? (seats.length === 1 ? seats[0]!.seatBookingId : null));
      } catch {
        if (!cancelled) setBasis({ kind: 'problem', message: 'Нет связи с сервером. Проверьте подключение и обновите страницу.' });
      }
    })();
    return () => { cancelled = true; };
  }, [carrierSlug, initialSeat]);

  async function submit() {
    if (rating < 1) { setError('Поставьте оценку от 1 до 5 звёзд'); return; }
    let payload: Record<string, unknown>;
    if (basis.kind === 'link') {
      payload = { via: 'link', carrier: carrierSlug, key: basis.key, author_name: authorName, rating, comment: comment.trim() };
    } else if (basis.kind === 'seats' && seatId) {
      payload = { via: 'seat', carrier: carrierSlug, seat_booking_id: seatId, rating, comment: comment.trim() };
    } else {
      setError('Выберите поездку');
      return;
    }
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
      if (basis.kind === 'link') window.history.replaceState(null, '', carrierReviewPath(carrierSlug));
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

  if (basis.kind === 'login') {
    return (
      <div className="ds-card p-5 space-y-3 text-sm text-[var(--text-secondary)]">
        <p>
          Ехали местом в поездке, заказанным через Ведар? <Link href={`/auth/login?from=${encodeURIComponent(carrierReviewPath(carrierSlug))}`} className="text-[var(--ocean)] hover:underline">Войдите</Link> в
          тот аккаунт, в котором заказывали, — отзыв можно оставить на следующий день после поездки.
        </p>
        <p>Заказывали машину целиком — отзыв по ссылке, которую после поездки присылает менеджер Ведара.</p>
      </div>
    );
  }

  if (basis.kind === 'seats' && basis.seats.length === 0) {
    return (
      <div className="ds-card p-5 space-y-3 text-sm text-[var(--text-secondary)]">
        <p>
          В вашем аккаунте нет поездок с «{carrierName}», по которым можно оставить отзыв. Отзыв появляется на
          следующий день после поездки — по месту, которое перевозчик подтвердил, и одна поездка — один отзыв.
        </p>
        <p>Заказывали машину целиком — отзыв по ссылке, которую после поездки присылает менеджер Ведара.</p>
      </div>
    );
  }

  return (
    <div className="ds-card p-5 space-y-4">
      {basis.kind === 'link' ? (
        <p className="text-sm text-[var(--text-secondary)]">
          Поездка: машина под заказ{basis.destination ? ` — ${basis.destination}` : ''}
          {basis.dateFrom ? `, ${rideDateWords(basis.dateFrom)}${basis.dateTo && basis.dateTo !== basis.dateFrom ? ` — ${rideDateWords(basis.dateTo)}` : ''}` : ''}.
          Менеджер Ведара подтвердил, что она состоялась.
        </p>
      ) : (
        <fieldset>
          <legend className="ds-label mb-2">Поездка</legend>
          <div className="space-y-2">
            {basis.seats.map((s) => (
              <label key={s.seatBookingId} className="flex items-center gap-2 text-sm text-[var(--text-primary)]" style={{ minHeight: 44 }}>
                <input type="radio" name="seat" value={s.seatBookingId} checked={seatId === s.seatBookingId} onChange={() => setSeatId(s.seatBookingId)} />
                {s.from} — {s.to}, {rideDateWords(s.date)}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {basis.kind === 'link' && (
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
      )}

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
