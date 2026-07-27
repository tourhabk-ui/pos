'use client';

import { useState } from 'react';
import { DataTable } from '@/components/admin/shared/DataTable';
import { LoadingSpinner } from '@/components/admin/shared/LoadingSpinner';
import { StatusBadge } from '@/components/admin/shared/StatusBadge';
import { Star, Plus, Loader2 } from 'lucide-react';
import { useApiFetch } from '@/hooks/use-api-fetch';

interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  rating: number;
  totalTrips: number;
  status: string;
  licenseExpiry: string;
}

interface DriversApiResponse {
  drivers: Driver[];
}

const INPUT = 'w-full px-3 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

const EMPTY_FORM = { firstName: '', lastName: '', phone: '', licenseNumber: '', licenseExpiry: '', experience: '' };

export default function DriversPageClient() {
  const { data: drivers, loading, refetch } = useApiFetch<DriversApiResponse, Driver[]>(
    '/api/transfer-operator/drivers',
    (d) => d?.drivers ?? [],
  );

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const list = drivers ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const res = await fetch('/api/transfer-operator/drivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          phone: form.phone.trim(),
          licenseNumber: form.licenseNumber.trim(),
          licenseExpiry: form.licenseExpiry,
          ...(form.experience.trim() ? { experience: Number(form.experience) } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFormError(json.error || 'Не удалось добавить водителя');
        return;
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      await refetch();
    } catch {
      setFormError('Не удалось добавить водителя — проверьте соединение');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    {
      key: 'name',
      header: 'Водитель',
      render: (d: Driver) => (
        <div>
          <div className="font-medium text-[var(--text-primary)]">
            {d.firstName} {d.lastName}
          </div>
          <div className="text-[var(--text-muted)] text-sm">{d.phone}</div>
        </div>
      ),
    },
    {
      key: 'rating',
      header: 'Рейтинг',
      render: (d: Driver) => (
        <div className="flex items-center gap-1">
          <Star className="w-4 h-4 text-[var(--text-secondary)]" />
          <span className="text-[var(--text-primary)]">{d.rating?.toFixed(1)}</span>
        </div>
      ),
    },
    {
      key: 'totalTrips',
      header: 'Поездок',
      render: (d: Driver) => (
        <div className="text-[var(--text-primary)]">{d.totalTrips}</div>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (d: Driver) => <StatusBadge status={d.status} />,
    },
    {
      key: 'licenseExpiry',
      header: 'Лицензия до',
      render: (d: Driver) => (
        <div className="text-[var(--text-secondary)] text-sm">
          {new Date(d.licenseExpiry).toLocaleDateString('ru-RU')}
        </div>
      ),
    },
  ];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-[var(--text-primary)]">Водители</h1>
        <button
          onClick={() => setShowForm(s => !s)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Добавить водителя
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="ds-label">Имя</label>
              <input
                required
                value={form.firstName}
                onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                className={INPUT}
              />
            </div>
            <div>
              <label className="ds-label">Фамилия</label>
              <input
                required
                value={form.lastName}
                onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                className={INPUT}
              />
            </div>
            <div>
              <label className="ds-label">Телефон</label>
              <input
                required
                type="tel"
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="+7 900 000-00-00"
                className={INPUT}
              />
            </div>
            <div>
              <label className="ds-label">Номер водительского удостоверения</label>
              <input
                required
                value={form.licenseNumber}
                onChange={e => setForm(f => ({ ...f, licenseNumber: e.target.value }))}
                className={INPUT}
              />
            </div>
            <div>
              <label className="ds-label">Удостоверение действует до</label>
              <input
                required
                type="date"
                value={form.licenseExpiry}
                onChange={e => setForm(f => ({ ...f, licenseExpiry: e.target.value }))}
                className={INPUT}
              />
            </div>
            <div>
              <label className="ds-label">Стаж, лет (необязательно)</label>
              <input
                type="number"
                min={0}
                max={70}
                value={form.experience}
                onChange={e => setForm(f => ({ ...f, experience: e.target.value }))}
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
          <DataTable<Driver> data={list} columns={columns} emptyMessage="Нет водителей — добавьте первого" />
        </div>
      )}
    </div>
  );
}
