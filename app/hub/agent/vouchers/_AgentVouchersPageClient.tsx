'use client';

import { useState } from 'react';
import { Ticket, Plus, Loader2 } from 'lucide-react';
import { DataTable } from '@/components/admin/shared/DataTable';
import { LoadingSpinner } from '@/components/admin/shared/LoadingSpinner';
import { useApiFetch } from '@/hooks/use-api-fetch';

interface Voucher {
  id: string;
  code: string;
  name: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  usedCount: number;
  usageLimit: number | null;
  validTo: string;
}

interface VouchersApiResponse {
  vouchers: Voucher[];
}

const INPUT = 'w-full px-3 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

const EMPTY_FORM = {
  name: '', code: '', discountType: 'percentage', discountValue: '10',
  validFrom: '', validTo: '', usageLimit: '',
};

export default function AgentVouchersPageClient() {
  const { data: vouchers, loading, refetch } = useApiFetch<VouchersApiResponse, Voucher[]>(
    '/api/agent/vouchers',
    (d) => d?.vouchers ?? [],
  );

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const list = vouchers ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (form.validTo <= form.validFrom) {
      setFormError('Дата окончания должна быть позже даты начала');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/agent/vouchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          code: form.code.trim().toUpperCase(),
          discountType: form.discountType,
          discountValue: Number(form.discountValue),
          validFrom: form.validFrom,
          validTo: form.validTo,
          ...(form.usageLimit.trim() ? { usageLimit: Number(form.usageLimit) } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFormError(json.error || 'Не удалось создать ваучер');
        return;
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      await refetch();
    } catch {
      setFormError('Не удалось создать ваучер — проверьте соединение');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    {
      key: 'code',
      header: 'Код',
      render: (v: Voucher) => (
        <div className="font-mono text-[var(--text-primary)]">{v.code}</div>
      ),
    },
    {
      key: 'name',
      header: 'Название',
      render: (v: Voucher) => <div className="text-[var(--text-primary)]">{v.name}</div>,
    },
    {
      key: 'discountValue',
      header: 'Скидка',
      render: (v: Voucher) => (
        <div className="text-[var(--success)]">
          {v.discountType === 'percentage' ? `${v.discountValue}%` : `${v.discountValue} ₽`}
        </div>
      ),
    },
    {
      key: 'usedCount',
      header: 'Использовано',
      render: (v: Voucher) => (
        <div className="text-[var(--text-secondary)]">
          {v.usedCount} {v.usageLimit ? `/ ${v.usageLimit}` : ''}
        </div>
      ),
    },
    {
      key: 'validTo',
      header: 'Действует до',
      render: (v: Voucher) => (
        <div className="text-[var(--text-secondary)]">
          {new Date(v.validTo).toLocaleDateString('ru-RU')}
        </div>
      ),
    },
  ];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="ds-h1 flex items-center gap-2">
          <Ticket className="w-6 h-6 text-[var(--ocean)]" />
          Ваучеры
        </h1>
        <button
          onClick={() => setShowForm(s => !s)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Новый ваучер
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="ds-label">Название</label>
              <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Летняя скидка" className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Код</label>
              <input required value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} placeholder="SUMMER2026" className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Тип скидки</label>
              <select value={form.discountType} onChange={e => setForm(f => ({ ...f, discountType: e.target.value }))} className={INPUT}>
                <option value="percentage">Процент</option>
                <option value="fixed">Фиксированная сумма</option>
              </select>
            </div>
            <div>
              <label className="ds-label">{form.discountType === 'percentage' ? 'Размер, %' : 'Размер, ₽'}</label>
              <input required type="number" min={1} value={form.discountValue} onChange={e => setForm(f => ({ ...f, discountValue: e.target.value }))} className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Действует с</label>
              <input required type="date" value={form.validFrom} onChange={e => setForm(f => ({ ...f, validFrom: e.target.value }))} className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Действует до</label>
              <input required type="date" min={form.validFrom || undefined} value={form.validTo} onChange={e => setForm(f => ({ ...f, validTo: e.target.value }))} className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Лимит использований (необязательно)</label>
              <input type="number" min={1} value={form.usageLimit} onChange={e => setForm(f => ({ ...f, usageLimit: e.target.value }))} className={INPUT} />
            </div>
          </div>
          {formError && <p className="text-sm text-[var(--danger)]">{formError}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowForm(false); setFormError(''); }} className="px-4 py-2.5 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:text-[var(--text-primary)] transition-colors">
              Отмена
            </button>
            <button type="submit" disabled={saving} className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Создать
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <LoadingSpinner message="Загрузка..." />
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
          <DataTable<Voucher> data={list} columns={columns} emptyMessage="Нет ваучеров — создайте первый" />
        </div>
      )}
    </div>
  );
}
