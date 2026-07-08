'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BedDouble, MapPin, CalendarDays, X, Star } from 'lucide-react';
import StayReviewForm from './_StayReviewForm';

/**
 * Брони жилья гостя (GET /api/stay/bookings/my). Отмена будущих
 * pending/confirmed — POST /api/stay/bookings/[id]/cancel.
 */

interface StayBooking {
  id: string;
  status: string;
  paymentStatus: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  totalPrice: number | null;
  accommodationId: string;
  accommodationName: string;
  address: string;
  roomName: string | null;
  cancellable: boolean;
  reviewable: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Ожидает подтверждения',
  confirmed: 'Подтверждена',
  completed: 'Завершена',
  cancelled: 'Отменена',
  no_show: 'Неявка',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--warning)',
  confirmed: 'var(--success)',
  completed: 'var(--text-secondary)',
  cancelled: 'var(--danger)',
  no_show: 'var(--danger)',
};

const PAYMENT_LABELS: Record<string, string> = {
  pending: 'Не оплачено',
  paid: 'Оплачено',
  refunded: 'Возврат',
  partially_refunded: 'Частичный возврат',
};

function formatMoney(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(v) + ' ₽';
}

function fmtDate(d: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('.') : d;
}

export default function StaysClient() {
  const [bookings, setBookings] = useState<StayBooking[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/stay/bookings/my')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { bookings: StayBooking[] } } | null) => {
        if (d?.success && Array.isArray(d.data?.bookings)) setBookings(d.data.bookings);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function cancel(booking: StayBooking) {
    if (!window.confirm(`Отменить бронь «${booking.accommodationName}»?`)) return;
    setBusyId(booking.id);
    setError(null);
    try {
      const res = await fetch(`/api/stay/bookings/${booking.id}/cancel`, { method: 'POST' });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось отменить бронь');
        return;
      }
      load();
    } catch {
      setError('Не удалось отменить бронь');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <BedDouble className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Мои проживания</h1>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {failed && <p className="text-sm text-[var(--danger)]">Не удалось загрузить брони. Обновите страницу.</p>}

      {bookings === null && !failed && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="ds-skeleton h-24 rounded-lg" />)}
        </div>
      )}

      {bookings !== null && bookings.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            У вас пока нет броней жилья.
          </p>
          <Link href="/accommodations" className="ds-btn ds-btn-primary">Найти жильё</Link>
        </div>
      )}

      {bookings !== null && bookings.map(b => (
        <div key={b.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link href={`/accommodations/${b.accommodationId}`}
                className="text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors">
                {b.accommodationName}
              </Link>
              {b.roomName && <span className="text-xs text-[var(--text-muted)]"> · {b.roomName}</span>}
              <p className="text-xs text-[var(--text-secondary)] mt-1 flex items-center gap-1">
                <MapPin className="w-3 h-3" /> {b.address}
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1 flex items-center gap-1">
                <CalendarDays className="w-3 h-3" />
                {fmtDate(b.checkInDate)} — {fmtDate(b.checkOutDate)} · {b.nights} ноч.
              </p>
              <div className="flex items-center gap-2 flex-wrap mt-2">
                <span className="ds-badge border border-[var(--border)]" style={{ color: STATUS_COLOR[b.status] }}>
                  {STATUS_LABELS[b.status] ?? b.status}
                </span>
                <span className="ds-badge border border-[var(--border)] text-[var(--text-muted)]">
                  {PAYMENT_LABELS[b.paymentStatus] ?? b.paymentStatus}
                </span>
                {b.totalPrice != null && (
                  <span className="text-xs font-semibold text-[var(--text-primary)]">{formatMoney(b.totalPrice)}</span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              {b.cancellable && (
                <button
                  onClick={() => cancel(b)}
                  disabled={busyId === b.id}
                  className="ds-btn ds-btn-secondary text-xs"
                >
                  <X className="w-3.5 h-3.5" /> {busyId === b.id ? 'Отмена…' : 'Отменить'}
                </button>
              )}
              {b.reviewable && reviewingId !== b.id && (
                <button
                  onClick={() => setReviewingId(b.id)}
                  className="ds-btn ds-btn-secondary text-xs"
                >
                  <Star className="w-3.5 h-3.5" /> Отзыв
                </button>
              )}
            </div>
          </div>
          {b.reviewable && reviewingId === b.id && (
            <StayReviewForm
              accommodationId={b.accommodationId}
              bookingId={b.id}
              onDone={() => { setReviewingId(null); load(); }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
