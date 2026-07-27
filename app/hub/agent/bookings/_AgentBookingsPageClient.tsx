'use client';

import { useState, useEffect } from 'react';
import { Handshake, Plus, Loader2 } from 'lucide-react';
import { DataTable } from '@/components/admin/shared/DataTable';
import { LoadingSpinner } from '@/components/admin/shared/LoadingSpinner';
import { StatusBadge } from '@/components/admin/shared/StatusBadge';
import { useApiFetch } from '@/hooks/use-api-fetch';

interface AgentBooking {
  id: string;
  clientName: string;
  clientEmail: string;
  tourName: string;
  tourDate: string;
  totalPrice: number;
  agentCommission: number;
  status: string;
}

interface AgentBookingsApiResponse {
  bookings: AgentBooking[];
}

interface ClientOption { id: string; name: string; email: string }

/** Слот из /api/agent/find-tours — тур+дата с ЧЕСТНОЙ занятостью. */
interface TourSlot { tour_id: string; title: string; available_date: string }

const INPUT = 'w-full px-3 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

const EMPTY_FORM = { clientId: '', slot: '', guestsCount: '2', voucherCode: '', notes: '' };

export default function AgentBookingsPageClient() {
  const { data: bookings, loading, refetch } = useApiFetch<AgentBookingsApiResponse, AgentBooking[]>(
    '/api/agent/bookings',
    (d) => d?.bookings ?? [],
  );

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [slots, setSlots] = useState<TourSlot[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  // Справочники грузим при первом открытии формы, не на каждый рендер списка.
  useEffect(() => {
    if (!showForm || clients.length > 0) return;
    let cancelled = false;
    setOptionsLoading(true);
    Promise.all([
      fetch('/api/agent/clients?limit=100').then(r => r.json()).catch(() => null),
      // Слоты с честной занятостью — та же выдача, что «Найти тур».
      fetch('/api/agent/find-tours?group_size=1&limit=100').then(r => r.json()).catch(() => null),
    ]).then(([c, t]) => {
      if (cancelled) return;
      setClients((c?.data?.clients ?? []).map((x: ClientOption) => ({ id: x.id, name: x.name, email: x.email })));
      setSlots((t?.data ?? []) as TourSlot[]);
    }).finally(() => { if (!cancelled) setOptionsLoading(false); });
    return () => { cancelled = true; };
  }, [showForm, clients.length]);

  const list = bookings ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    const [tourId, tourDate] = form.slot.split('|');
    if (!tourId || !tourDate) {
      setFormError('Выберите тур и дату из списка');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/agent/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: form.clientId,
          tourId,
          tourDate,
          guestsCount: Number(form.guestsCount),
          ...(form.voucherCode.trim() ? { voucherCode: form.voucherCode.trim() } : {}),
          ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFormError(json.error || 'Не удалось создать бронирование');
        return;
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      await refetch();
    } catch {
      setFormError('Не удалось создать бронирование — проверьте соединение');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    {
      key: 'clientName',
      header: 'Клиент',
      render: (booking: AgentBooking) => (
        <div>
          <div className="font-medium text-[var(--text-primary)]">{booking.clientName}</div>
          <div className="text-[var(--text-muted)] text-sm">{booking.clientEmail}</div>
        </div>
      ),
    },
    {
      key: 'tourName',
      header: 'Тур',
      render: (booking: AgentBooking) => (
        <div className="text-[var(--text-primary)]">{booking.tourName}</div>
      ),
    },
    {
      key: 'tourDate',
      header: 'Дата',
      render: (booking: AgentBooking) => (
        <div className="text-[var(--text-secondary)]">
          {new Date(booking.tourDate).toLocaleDateString('ru-RU')}
        </div>
      ),
    },
    {
      key: 'totalPrice',
      header: 'Сумма',
      render: (booking: AgentBooking) => (
        <div className="font-medium text-[var(--text-primary)]">
          {booking.totalPrice?.toLocaleString('ru-RU')} ₽
        </div>
      ),
    },
    {
      key: 'agentCommission',
      header: 'Комиссия',
      render: (booking: AgentBooking) => (
        <div className="font-medium text-[var(--success)]">
          {booking.agentCommission?.toLocaleString('ru-RU')} ₽
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (booking: AgentBooking) => <StatusBadge status={booking.status} />,
    },
  ];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="ds-h1 flex items-center gap-2">
          <Handshake className="w-6 h-6 text-[var(--ocean)]" />
          Бронирования
        </h1>
        <button
          onClick={() => setShowForm(s => !s)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Новая бронь
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-4">
          {optionsLoading ? (
            <LoadingSpinner message="Загрузка клиентов и туров..." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="ds-label">Клиент</label>
                <select required value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} className={INPUT}>
                  <option value="">— выберите клиента —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
                </select>
                {clients.length === 0 && (
                  <p className="text-xs text-[var(--text-muted)] mt-1">Нет клиентов — сначала добавьте в разделе «Клиенты»</p>
                )}
              </div>
              <div>
                <label className="ds-label">Тур и дата (по свободным местам)</label>
                <select required value={form.slot} onChange={e => setForm(f => ({ ...f, slot: e.target.value }))} className={INPUT}>
                  <option value="">— выберите слот —</option>
                  {slots.map(s => (
                    <option key={`${s.tour_id}|${s.available_date}`} value={`${s.tour_id}|${s.available_date}`}>
                      {s.title} — {new Date(s.available_date).toLocaleDateString('ru-RU')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="ds-label">Гостей</label>
                <input required type="number" min={1} max={50} value={form.guestsCount} onChange={e => setForm(f => ({ ...f, guestsCount: e.target.value }))} className={INPUT} />
              </div>
              <div>
                <label className="ds-label">Код ваучера (необязательно)</label>
                <input value={form.voucherCode} onChange={e => setForm(f => ({ ...f, voucherCode: e.target.value }))} className={INPUT} />
              </div>
              <div className="sm:col-span-2">
                <label className="ds-label">Заметка (необязательно)</label>
                <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className={INPUT} />
              </div>
            </div>
          )}
          {formError && <p className="text-sm text-[var(--danger)]">{formError}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowForm(false); setFormError(''); }} className="px-4 py-2.5 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:text-[var(--text-primary)] transition-colors">
              Отмена
            </button>
            <button type="submit" disabled={saving || optionsLoading} className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Создать бронь
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <LoadingSpinner message="Загрузка..." />
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
          <DataTable<AgentBooking>
            data={list}
            columns={columns}
            emptyMessage="Нет бронирований"
          />
        </div>
      )}
    </div>
  );
}
