'use client';

import { useState } from 'react';
import { DataTable } from '@/components/admin/shared/DataTable';
import { LoadingSpinner } from '@/components/admin/shared/LoadingSpinner';
import { StatusBadge } from '@/components/admin/shared/StatusBadge';
import { Plus, Loader2 } from 'lucide-react';
import { useApiFetch } from '@/hooks/use-api-fetch';

interface Vehicle {
  id: string;
  name: string;
  licensePlate: string;
  type: string;
  capacity: number;
  status: string;
  location: string;
}

interface VehiclesApiResponse {
  vehicles: Vehicle[];
}

// Значения — контракт createVehicleSchema (app/api/transfer/vehicles).
const VEHICLE_TYPES = [
  { value: 'car', label: 'Легковой' },
  { value: 'minivan', label: 'Минивэн' },
  { value: 'bus', label: 'Автобус' },
  { value: 'helicopter', label: 'Вертолёт' },
  { value: 'boat', label: 'Катер' },
] as const;

const VEHICLE_CATEGORIES = [
  { value: 'economy', label: 'Эконом' },
  { value: 'comfort', label: 'Комфорт' },
  { value: 'business', label: 'Бизнес' },
  { value: 'premium', label: 'Премиум' },
] as const;

const TYPE_LABELS: Record<string, string> = Object.fromEntries(
  VEHICLE_TYPES.map(t => [t.value, t.label]),
);

const INPUT = 'w-full px-3 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

const EMPTY_FORM = { name: '', type: 'minivan', licensePlate: '', capacity: '8', category: 'comfort', year: '' };

export default function VehiclesPageClient() {
  const { data: vehicles, loading, refetch } = useApiFetch<VehiclesApiResponse, Vehicle[]>(
    '/api/transfer-operator/vehicles',
    (d) => d?.vehicles ?? [],
  );

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const list = vehicles ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const res = await fetch('/api/transfer-operator/vehicles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          type: form.type,
          licensePlate: form.licensePlate.trim(),
          capacity: Number(form.capacity),
          category: form.category,
          ...(form.year.trim() ? { year: Number(form.year) } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFormError(json.error || 'Не удалось добавить транспорт');
        return;
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      await refetch();
    } catch {
      setFormError('Не удалось добавить транспорт — проверьте соединение');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    {
      key: 'name',
      header: 'Транспорт',
      render: (v: Vehicle) => (
        <div>
          <div className="font-medium text-[var(--text-primary)]">{v.name}</div>
          <div className="text-[var(--text-muted)] text-sm">{v.licensePlate}</div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Тип',
      render: (v: Vehicle) => (
        <div className="text-[var(--text-primary)]">{TYPE_LABELS[v.type] ?? v.type}</div>
      ),
    },
    {
      key: 'capacity',
      header: 'Вместимость',
      render: (v: Vehicle) => (
        <div className="text-[var(--text-primary)]">{v.capacity} мест</div>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (v: Vehicle) => <StatusBadge status={v.status} />,
    },
    {
      key: 'location',
      header: 'Локация',
      render: (v: Vehicle) => (
        <div className="text-[var(--text-secondary)]">{v.location}</div>
      ),
    },
  ];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-[var(--text-primary)]">Транспортные средства</h1>
        <button
          onClick={() => setShowForm(s => !s)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Добавить транспорт
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="ds-label">Название</label>
              <input
                required
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Toyota HiAce"
                className={INPUT}
              />
            </div>
            <div>
              <label className="ds-label">Госномер</label>
              <input
                required
                value={form.licensePlate}
                onChange={e => setForm(f => ({ ...f, licensePlate: e.target.value }))}
                placeholder="А123БВ 41"
                className={INPUT}
              />
            </div>
            <div>
              <label className="ds-label">Тип</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className={INPUT}>
                {VEHICLE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="ds-label">Класс</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className={INPUT}>
                {VEHICLE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="ds-label">Мест</label>
              <input
                required
                type="number"
                min={1}
                max={200}
                value={form.capacity}
                onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))}
                className={INPUT}
              />
            </div>
            <div>
              <label className="ds-label">Год выпуска (необязательно)</label>
              <input
                type="number"
                min={1950}
                max={2100}
                value={form.year}
                onChange={e => setForm(f => ({ ...f, year: e.target.value }))}
                className={INPUT}
              />
            </div>
          </div>
          {formError && <p className="text-sm text-[var(--danger)]">{formError}</p>}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setShowForm(false); setFormError(''); }}
              className="px-4 py-2.5 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:text-[var(--text-primary)] transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Сохранить
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <LoadingSpinner message="Загрузка..." />
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
          <DataTable<Vehicle> data={list} columns={columns} emptyMessage="Нет транспорта — добавьте первую машину" />
        </div>
      )}
    </div>
  );
}
