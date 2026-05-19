'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { Protected } from '@/components/auth/Protected';
import { Calendar, Loader2, Search, Download, AlertCircle, X, RefreshCw } from 'lucide-react';

type BStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled';
interface Booking {
  id: string; tourName: string; touristName: string; touristEmail: string;
  date: string; price: number; status: BStatus;
}

const ST_CLS: Record<BStatus, string> = {
  pending:   'bg-[var(--warning)]/15 text-[var(--warning)]',
  confirmed: 'bg-[var(--accent)]/15 text-[var(--accent)]',
  completed: 'bg-[var(--success)]/15 text-[var(--success)]',
  cancelled: 'bg-[var(--danger)]/15 text-[var(--danger)]',
};
const ST_LBL: Record<BStatus, string> = {
  pending: 'Ожидает', confirmed: 'Подтверждён', completed: 'Завершён', cancelled: 'Отменён',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU');
}

function formatUpdated(d: Date) {
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export default function AdminBookingsClient() {
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [bookings, setBookings]   = useState<Booking[]>([]);
  const [search, setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<BStatus | 'all'>('all');
  const [total, setTotal]         = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await fetch(`/api/admin/bookings?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Ошибка загрузки');
      const rows = json.data?.bookings ?? [];
      setTotal(json.data?.total ?? rows.length);
      setBookings(rows.map((b: {
        id: string; tourName: string; userName: string; userEmail: string;
        createdAt: string; totalPrice: number; status: string;
      }) => ({
        id: b.id,
        tourName: b.tourName,
        touristName: b.userName,
        touristEmail: b.userEmail,
        date: b.createdAt,
        price: b.totalPrice,
        status: b.status as BStatus,
      })));
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки данных');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const filtered = bookings.filter(b =>
    b.tourName.toLowerCase().includes(search.toLowerCase()) ||
    b.touristName.toLowerCase().includes(search.toLowerCase()) ||
    b.touristEmail.toLowerCase().includes(search.toLowerCase())
  );

  const exportCSV = () => {
    const csv = ['Тур,Турист,Email,Дата,Цена,Статус',
      ...filtered.map(b =>
        `"${b.tourName}","${b.touristName}","${b.touristEmail}","${formatDate(b.date)}","${b.price}","${ST_LBL[b.status]}"`
      )].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'bookings.csv';
    a.click();
    toast.success(`Экспортировано ${filtered.length} записей`);
  };

  return (
    <Protected roles={['admin']}>
      <div className="max-w-6xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Calendar className="w-6 h-6 text-[var(--accent)]" />
            <div>
              <h1 className="text-2xl font-bold text-[var(--text-primary)]">Все бронирования</h1>
              {lastUpdated && (
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Обновлено в {formatUpdated(lastUpdated)}
                </p>
              )}
            </div>
            {!loading && <span className="text-sm text-[var(--text-muted)]">{total}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              className="min-h-[44px] px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-secondary)] text-sm inline-flex items-center gap-2 hover:border-[var(--accent)] transition-colors disabled:opacity-50"
              title="Обновить"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={exportCSV}
              disabled={filtered.length === 0}
              className="min-h-[44px] px-4 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-secondary)] text-sm inline-flex items-center gap-2 hover:border-[var(--border-strong)] disabled:opacity-40"
            >
              <Download className="w-4 h-4" /> Экспорт CSV
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              ref={searchRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск по туру, туристу или email..."
              className="w-full min-h-[44px] pl-10 pr-10 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
            />
            {search && (
              <button
                onClick={() => { setSearch(''); searchRef.current?.focus(); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {(['all', 'pending', 'confirmed', 'completed', 'cancelled'] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`min-h-[44px] px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${
                  statusFilter === s
                    ? 'bg-[var(--accent)] text-[var(--bg-primary)]'
                    : 'bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]'
                }`}
              >
                {s === 'all' ? 'Все' : ST_LBL[s]}
              </button>
            ))}
          </div>
        </div>

        {/* Search result count */}
        {search && !loading && (
          <p className="text-xs text-[var(--text-muted)] mb-3">
            Найдено {filtered.length} из {bookings.length}
          </p>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center py-16 gap-3">
            <AlertCircle className="w-8 h-8 text-[var(--danger)]" />
            <p className="text-[var(--text-secondary)] text-sm">{error}</p>
            <button onClick={load} className="text-sm text-[var(--accent)] underline">Повторить</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Calendar className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-[var(--text-secondary)]">
              {search ? 'По вашему запросу ничего не найдено' : 'Бронирования не найдены'}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="p-3">Тур</th>
                    <th className="p-3">Турист</th>
                    <th className="p-3">Email</th>
                    <th className="p-3">Дата брони</th>
                    <th className="p-3">Цена</th>
                    <th className="p-3">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(b => (
                    <tr key={b.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-hover)]">
                      <td className="p-3 text-[var(--text-primary)]">{b.tourName}</td>
                      <td className="p-3 text-[var(--text-secondary)]">{b.touristName}</td>
                      <td className="p-3 text-[var(--text-muted)] text-xs" title={b.touristEmail}>{b.touristEmail}</td>
                      <td className="p-3 text-[var(--text-secondary)]">{formatDate(b.date)}</td>
                      <td className="p-3 text-[var(--text-primary)] font-medium">
                        {b.price.toLocaleString('ru-RU')} ₽
                      </td>
                      <td className="p-3">
                        <span className={`text-xs px-2 py-1 rounded-full ${ST_CLS[b.status] ?? ''}`}>
                          {ST_LBL[b.status] ?? b.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-3">
              {filtered.map(b => (
                <div key={b.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="font-medium text-[var(--text-primary)] text-sm leading-tight">{b.tourName}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${ST_CLS[b.status] ?? ''}`}>
                      {ST_LBL[b.status] ?? b.status}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--text-secondary)]">{b.touristName}</p>
                  <p className="text-xs text-[var(--text-muted)] truncate">{b.touristEmail}</p>
                  <div className="flex items-center justify-between mt-3 pt-2 border-t border-[var(--border)]">
                    <span className="text-xs text-[var(--text-muted)]">{formatDate(b.date)}</span>
                    <span className="text-sm font-semibold text-[var(--text-primary)]">
                      {b.price.toLocaleString('ru-RU')} ₽
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Protected>
  );
}
