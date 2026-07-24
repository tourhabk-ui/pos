'use client';

import { useEffect, useState, useCallback } from 'react';
import { Protected } from '@/components/auth/Protected';
import { Calendar, Loader2, Users, MapPin, Phone, RefreshCw } from 'lucide-react';

// Шаттл-брони приходят из публичного флоу (место на расписании → оплата →
// подтверждение), а не «оператор принимает заявку». Поэтому экран — честный
// список РЕАЛЬНЫХ броней (только чтение), без фейковых кнопок «подтвердить».
type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled';

interface ApiBooking {
  id: string;
  booking_date: string;
  departure_time: string | null;
  passengers_count: number;
  total_price: string;
  status: string;
  contact_phone: string | null;
  confirmation_code: string | null;
  created_at: string;
  from_location: string | null;
  to_location: string | null;
}

const STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Ожидает оплаты', confirmed: 'Подтверждён', completed: 'Завершён', cancelled: 'Отменён',
};
const STATUS_CLASSES: Record<BookingStatus, string> = {
  pending: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  confirmed: 'bg-[var(--success)]/15 text-[var(--success)]',
  completed: 'bg-[var(--ocean)]/15 text-[var(--ocean)]',
  cancelled: 'bg-[var(--danger)]/15 text-[var(--danger)]',
};

function statusLabel(s: string): string {
  return STATUS_LABELS[s as BookingStatus] ?? s;
}

export default function TransferBookingsClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bookings, setBookings] = useState<ApiBooking[]>([]);
  const [filter, setFilter] = useState<BookingStatus | 'all'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/transfer/bookings', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || 'Не удалось загрузить бронирования');
      }
      setBookings((json.data?.bookings ?? []) as ApiBooking[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = filter === 'all' ? bookings : bookings.filter(b => b.status === filter);

  return (
    <Protected roles={['transfer_operator', 'transfer', 'admin']}>
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <Calendar className="w-6 h-6 text-[var(--accent)]" />
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">Бронирования трансферов</h1>
          </div>
          <button onClick={() => void load()} disabled={loading}
            className="min-h-[44px] px-3 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] inline-flex items-center gap-2 hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Обновить
          </button>
        </div>
        <p className="text-sm text-[var(--text-muted)] mb-6">Брони подтверждаются автоматически после оплаты клиентом. Список отражает реальные заказы вашего автопарка.</p>

        <div className="flex gap-2 mb-4 overflow-x-auto">
          {(['all', 'pending', 'confirmed', 'completed', 'cancelled'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`min-h-[44px] px-3 py-2 rounded-xl text-sm whitespace-nowrap transition-colors ${filter === f ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)]'}`}>
              {f === 'all' ? 'Все' : STATUS_LABELS[f]}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" /></div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-[var(--danger)] mb-3">{error}</p>
            <button onClick={() => void load()} className="min-h-[44px] px-4 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)]">Повторить</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16"><Calendar className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" /><p className="text-[var(--text-secondary)]">Нет бронирований</p></div>
        ) : (
          <div className="space-y-3">
            {filtered.map(b => {
              const route = b.from_location && b.to_location ? `${b.from_location} — ${b.to_location}` : 'Маршрут не указан';
              const price = Number(b.total_price) || 0;
              return (
                <div key={b.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2"><MapPin className="w-4 h-4 text-[var(--accent)] shrink-0" /><span className="font-medium text-[var(--text-primary)] truncate">{route}</span></div>
                    <div className="flex items-center gap-4 mt-1.5 text-sm text-[var(--text-secondary)] flex-wrap">
                      <span>{b.booking_date ? new Date(b.booking_date).toLocaleDateString('ru-RU') : '—'}{b.departure_time ? `, ${b.departure_time.slice(0, 5)}` : ''}</span>
                      <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{b.passengers_count}</span>
                      <span className="text-[var(--accent)] font-medium">{price.toLocaleString('ru-RU')} ₽</span>
                      {b.contact_phone && <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" />{b.contact_phone}</span>}
                      {b.confirmation_code && <span className="text-[var(--text-muted)]">№ {b.confirmation_code}</span>}
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full shrink-0 ${STATUS_CLASSES[b.status as BookingStatus] ?? 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'}`}>{statusLabel(b.status)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Protected>
  );
}
