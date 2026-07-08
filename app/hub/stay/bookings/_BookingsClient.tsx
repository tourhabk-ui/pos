'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ClipboardList } from 'lucide-react';

/**
 * Входящие брони владельца жилья: список из GET /api/stay/bookings
 * (только свои объекты), смена статуса по жизненному циклу через
 * PATCH /api/stay/bookings/[id].
 */

const STATUS_LABELS: Record<string, string> = {
  pending: 'Ожидает',
  confirmed: 'Подтверждена',
  completed: 'Завершена',
  cancelled: 'Отменена',
  no_show: 'Гость не заехал',
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'text-[var(--warning)]',
  confirmed: 'text-[var(--ocean)]',
  completed: 'text-[var(--success)]',
  cancelled: 'text-[var(--danger)]',
  no_show: 'text-[var(--danger)]',
};

const PAYMENT_LABELS: Record<string, string> = {
  pending: 'не оплачено',
  paid: 'оплачено',
  refunded: 'возврат',
  partially_refunded: 'частичный возврат',
};

// Кнопки переходов по текущему статусу (см. ALLOWED_TRANSITIONS на бэкенде)
const TRANSITIONS: Record<string, { next: string; label: string; danger?: boolean }[]> = {
  pending: [
    { next: 'confirmed', label: 'Подтвердить' },
    { next: 'cancelled', label: 'Отменить', danger: true },
  ],
  confirmed: [
    { next: 'completed', label: 'Заезд состоялся' },
    { next: 'no_show', label: 'No-show', danger: true },
    { next: 'cancelled', label: 'Отменить', danger: true },
  ],
};

interface BookingRow {
  id: string;
  accommodation_name: string;
  room_name: string | null;
  guest_name: string | null;
  guest_email: string | null;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  adults: number;
  children: number;
  total_price: string | number;
  status: string;
  payment_status: string;
  refund_amount: string | number | null;
  refund_percent: number | null;
  special_requests: string | null;
  created_at: string;
}

function formatMoney(v: string | number): string {
  return new Intl.NumberFormat('ru-RU').format(Number(v)) + ' ₽';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU');
}

export default function BookingsClient() {
  const [bookings, setBookings] = useState<BookingRow[] | null>(null);
  const [noProfile, setNoProfile] = useState(false);
  const [failed, setFailed] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setBookings(null);
    setFailed(false);
    fetch(`/api/stay/bookings${statusFilter ? `?status=${statusFilter}` : ''}`)
      .then(r => {
        if (r.status === 404) {
          setNoProfile(true);
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((d: { success?: boolean; data?: { bookings: BookingRow[] } } | null) => {
        if (d === null) return;
        if (d?.success && Array.isArray(d.data?.bookings)) setBookings(d.data.bookings);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  async function changeStatus(booking: BookingRow, next: string) {
    setBusyId(booking.id);
    setError(null);
    try {
      const res = await fetch(`/api/stay/bookings/${booking.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось обновить статус брони');
      } else {
        load();
      }
    } catch {
      setError('Не удалось обновить статус брони');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <ClipboardList className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Входящие брони</h1>
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          aria-label="Фильтр по статусу"
          className="px-2.5 py-1.5 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]">
          <option value="">Все статусы</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {noProfile && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center max-w-lg">
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Кабинет ещё не настроен — заполните профиль и добавьте первый объект, брони будут приходить сюда.
          </p>
          <Link href="/hub/stay/onboarding" className="ds-btn ds-btn-primary">Настроить кабинет</Link>
        </div>
      )}

      {bookings === null && !failed && !noProfile && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="ds-skeleton h-20 rounded-lg" />)}
        </div>
      )}

      {failed && <p className="text-sm text-[var(--danger)]">Не удалось загрузить брони. Обновите страницу.</p>}

      {bookings !== null && bookings.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            {statusFilter ? 'Броней с таким статусом нет.' : 'Броней пока нет.'}
          </p>
        </div>
      )}

      {bookings !== null && bookings.map(booking => (
        <div key={booking.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  {booking.accommodation_name}
                  {booking.room_name && <span className="font-normal text-[var(--text-secondary)]"> · {booking.room_name}</span>}
                </p>
                <span className={`text-xs font-medium ${STATUS_BADGE[booking.status] ?? 'text-[var(--text-muted)]'}`}>
                  {STATUS_LABELS[booking.status] ?? booking.status}
                </span>
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {formatDate(booking.check_in_date)} — {formatDate(booking.check_out_date)} · {booking.nights} ноч. ·{' '}
                {booking.adults} взр.{booking.children > 0 && ` + ${booking.children} дет.`} ·{' '}
                {formatMoney(booking.total_price)} ({PAYMENT_LABELS[booking.payment_status] ?? booking.payment_status})
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {[booking.guest_name, booking.guest_email].filter(Boolean).join(' · ') || 'Гость не указан'}
              </p>
              {booking.status === 'cancelled' && booking.refund_amount != null && Number(booking.refund_amount) > 0 && (
                <p className="text-xs font-medium text-[var(--danger)] mt-1">
                  К возврату гостю: {formatMoney(booking.refund_amount)}
                  {booking.refund_percent != null && ` (${booking.refund_percent}%)`} — вручную по CloudPayments
                </p>
              )}
              {booking.special_requests && (
                <p className="text-xs text-[var(--text-muted)] mt-1">{booking.special_requests}</p>
              )}
            </div>
            {(TRANSITIONS[booking.status] ?? []).length > 0 && (
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                {(TRANSITIONS[booking.status] ?? []).map(t => (
                  <button
                    key={t.next}
                    onClick={() => changeStatus(booking, t.next)}
                    disabled={busyId === booking.id}
                    className={t.danger ? 'ds-btn ds-btn-danger' : 'ds-btn ds-btn-primary'}>
                    {busyId === booking.id ? '…' : t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
