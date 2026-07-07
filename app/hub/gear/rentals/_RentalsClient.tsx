'use client';

import { useCallback, useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';

/**
 * Заявки на аренду снаряжения: список из GET /api/gear/rentals
 * (партнёр видит только свои), смена статуса по жизненному циклу
 * через PATCH /api/gear/rentals/[id].
 */

const STATUS_LABELS: Record<string, string> = {
  pending: 'Ожидает',
  confirmed: 'Подтверждена',
  active: 'Выдано',
  completed: 'Завершена',
  cancelled: 'Отменена',
  overdue: 'Просрочена',
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'text-[var(--warning)]',
  confirmed: 'text-[var(--ocean)]',
  active: 'text-[var(--success)]',
  completed: 'text-[var(--text-muted)]',
  cancelled: 'text-[var(--danger)]',
  overdue: 'text-[var(--danger)]',
};

// Кнопки переходов по текущему статусу (см. ALLOWED_TRANSITIONS на бэкенде)
const TRANSITIONS: Record<string, { next: string; label: string; danger?: boolean }[]> = {
  pending: [
    { next: 'confirmed', label: 'Подтвердить' },
    { next: 'cancelled', label: 'Отклонить', danger: true },
  ],
  confirmed: [
    { next: 'active', label: 'Выдано' },
    { next: 'cancelled', label: 'Отменить', danger: true },
  ],
  active: [
    { next: 'completed', label: 'Возвращено' },
    { next: 'overdue', label: 'Просрочено', danger: true },
  ],
  overdue: [
    { next: 'completed', label: 'Возвращено' },
  ],
};

interface RentalRow {
  id: string;
  gear_name: string;
  gear_category: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  start_date: string;
  end_date: string;
  quantity: number;
  days_count: number;
  total_price: string | number;
  comments: string | null;
  status: string;
  created_at: string;
}

function formatMoney(v: string | number): string {
  return new Intl.NumberFormat('ru-RU').format(Number(v)) + ' ₽';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU');
}

export default function RentalsClient() {
  const [rentals, setRentals] = useState<RentalRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setRentals(null);
    setFailed(false);
    fetch(`/api/gear/rentals${statusFilter ? `?status=${statusFilter}` : ''}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { rentals: RentalRow[] } } | null) => {
        if (d?.success && Array.isArray(d.data?.rentals)) setRentals(d.data.rentals);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  async function changeStatus(rental: RentalRow, next: string) {
    setBusyId(rental.id);
    setError(null);
    try {
      const res = await fetch(`/api/gear/rentals/${rental.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось обновить статус аренды');
      } else {
        load();
      }
    } catch {
      setError('Не удалось обновить статус аренды');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <ClipboardList className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Заявки на аренду</h1>
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

      {rentals === null && !failed && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="ds-skeleton h-20 rounded-lg" />)}
        </div>
      )}

      {failed && <p className="text-sm text-[var(--danger)]">Не удалось загрузить заявки. Обновите страницу.</p>}

      {rentals !== null && rentals.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            {statusFilter ? 'Заявок с таким статусом нет.' : 'Заявок на аренду пока нет.'}
          </p>
        </div>
      )}

      {rentals !== null && rentals.map(rental => (
        <div key={rental.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-[var(--text-primary)]">{rental.gear_name}</p>
                <span className={`text-xs font-medium ${STATUS_BADGE[rental.status] ?? 'text-[var(--text-muted)]'}`}>
                  {STATUS_LABELS[rental.status] ?? rental.status}
                </span>
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {formatDate(rental.start_date)} — {formatDate(rental.end_date)} · {rental.days_count} дн. · {rental.quantity} шт. · {formatMoney(rental.total_price)}
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {rental.customer_name} · {rental.customer_phone} · {rental.customer_email}
              </p>
              {rental.comments && (
                <p className="text-xs text-[var(--text-muted)] mt-1">{rental.comments}</p>
              )}
            </div>
            {(TRANSITIONS[rental.status] ?? []).length > 0 && (
              <div className="flex items-center gap-2 shrink-0">
                {(TRANSITIONS[rental.status] ?? []).map(t => (
                  <button
                    key={t.next}
                    onClick={() => changeStatus(rental, t.next)}
                    disabled={busyId === rental.id}
                    className={t.danger ? 'ds-btn ds-btn-danger' : 'ds-btn ds-btn-primary'}>
                    {busyId === rental.id ? '…' : t.label}
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
