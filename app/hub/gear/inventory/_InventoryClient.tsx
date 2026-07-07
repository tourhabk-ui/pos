'use client';

import { useCallback, useEffect, useState } from 'react';
import { Backpack, Plus, Pencil, EyeOff, Eye, X } from 'lucide-react';

/**
 * Инвентарь проката: список позиций партнёра (включая скрытые),
 * создание (POST /api/gear/items), редактирование (PUT /api/gear/items/[id]),
 * снятие с публикации (DELETE) и возврат в публикацию (PUT isActive).
 */

const CATEGORY_LABELS: Record<string, string> = {
  tent: 'Палатки', backpack: 'Рюкзаки', sleeping_bag: 'Спальники',
  trekking: 'Треккинг', clothing: 'Одежда', footwear: 'Обувь',
  cooking: 'Кухня', navigation: 'Навигация', safety: 'Безопасность',
  fishing: 'Рыбалка', winter: 'Зимнее', climbing: 'Альпинизм',
  electronics: 'Электроника', other: 'Разное',
};

const CONDITION_OPTIONS = [
  { value: 'new', label: 'Новое' },
  { value: 'excellent', label: 'Отличное' },
  { value: 'good', label: 'Хорошее' },
  { value: 'fair', label: 'Нормальное' },
];

interface GearItemRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  brand: string | null;
  price_per_day: string | number;
  price_per_week: string | number | null;
  quantity: number;
  available_quantity: number;
  deposit_amount: string | number | null;
  condition: string;
  is_active: boolean;
}

interface ItemFormState {
  name: string;
  category: string;
  brand: string;
  description: string;
  pricePerDay: string;
  pricePerWeek: string;
  quantity: string;
  depositAmount: string;
  condition: string;
}

const EMPTY_FORM: ItemFormState = {
  name: '', category: 'tent', brand: '', description: '',
  pricePerDay: '', pricePerWeek: '', quantity: '1', depositAmount: '', condition: 'good',
};

function formatMoney(v: string | number): string {
  return new Intl.NumberFormat('ru-RU').format(Number(v)) + ' ₽';
}

function formToPayload(form: ItemFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    category: form.category,
    pricePerDay: Number(form.pricePerDay),
    quantity: Number(form.quantity),
    condition: form.condition,
  };
  if (form.brand.trim()) payload.brand = form.brand.trim();
  if (form.description.trim()) payload.description = form.description.trim();
  if (form.pricePerWeek) payload.pricePerWeek = Number(form.pricePerWeek);
  if (form.depositAmount) payload.depositAmount = Number(form.depositAmount);
  return payload;
}

function ItemForm({ form, setForm, onSubmit, onCancel, submitLabel, busy }: {
  form: ItemFormState;
  setForm: (f: ItemFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  busy: boolean;
}) {
  const valid = form.name.trim().length > 0 && Number(form.pricePerDay) > 0 && Number(form.quantity) > 0;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className="ds-label">Название</label>
        <input className="ds-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Палатка MSR Hubba 2" />
      </div>
      <div>
        <label className="ds-label">Категория</label>
        <select className="ds-input" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
          {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="ds-label">Бренд</label>
        <input className="ds-input" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} placeholder="MSR" />
      </div>
      <div>
        <label className="ds-label">Состояние</label>
        <select className="ds-input" value={form.condition} onChange={e => setForm({ ...form, condition: e.target.value })}>
          {CONDITION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div>
        <label className="ds-label">Цена за день, ₽</label>
        <input className="ds-input" type="number" min="1" value={form.pricePerDay} onChange={e => setForm({ ...form, pricePerDay: e.target.value })} />
      </div>
      <div>
        <label className="ds-label">Цена за неделю, ₽ (необязательно)</label>
        <input className="ds-input" type="number" min="1" value={form.pricePerWeek} onChange={e => setForm({ ...form, pricePerWeek: e.target.value })} />
      </div>
      <div>
        <label className="ds-label">Количество единиц</label>
        <input className="ds-input" type="number" min="1" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} />
      </div>
      <div>
        <label className="ds-label">Залог, ₽ (необязательно)</label>
        <input className="ds-input" type="number" min="0" value={form.depositAmount} onChange={e => setForm({ ...form, depositAmount: e.target.value })} />
      </div>
      <div className="sm:col-span-2">
        <label className="ds-label">Описание</label>
        <textarea className="ds-input" rows={2} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
      </div>
      <div className="sm:col-span-2 flex gap-2">
        <button className="ds-btn ds-btn-primary" onClick={onSubmit} disabled={!valid || busy}>
          {busy ? 'Сохранение…' : submitLabel}
        </button>
        <button className="ds-btn ds-btn-secondary" onClick={onCancel} disabled={busy}>Отмена</button>
      </div>
    </div>
  );
}

export default function InventoryClient() {
  const [items, setItems] = useState<GearItemRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<ItemFormState>(EMPTY_FORM);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ItemFormState>(EMPTY_FORM);

  const load = useCallback(() => {
    fetch('/api/gear/items')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { items: GearItemRow[] } } | null) => {
        if (d?.success && Array.isArray(d.data?.items)) setItems(d.data.items);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submitCreate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/gear/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formToPayload(createForm)),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось добавить снаряжение');
      } else {
        setCreating(false);
        setCreateForm(EMPTY_FORM);
        load();
      }
    } catch {
      setError('Не удалось добавить снаряжение');
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit() {
    if (!editingId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/gear/items/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formToPayload(editForm)),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось сохранить изменения');
      } else {
        setEditingId(null);
        load();
      }
    } catch {
      setError('Не удалось сохранить изменения');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(item: GearItemRow) {
    setBusy(true);
    setError(null);
    try {
      const res = item.is_active
        ? await fetch(`/api/gear/items/${item.id}`, { method: 'DELETE' })
        : await fetch(`/api/gear/items/${item.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isActive: true }),
          });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) setError(d.error || 'Не удалось изменить статус публикации');
      else load();
    } catch {
      setError('Не удалось изменить статус публикации');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(item: GearItemRow) {
    setEditingId(item.id);
    setEditForm({
      name: item.name,
      category: item.category,
      brand: item.brand ?? '',
      description: item.description ?? '',
      pricePerDay: String(Number(item.price_per_day)),
      pricePerWeek: item.price_per_week != null ? String(Number(item.price_per_week)) : '',
      quantity: String(item.quantity),
      depositAmount: item.deposit_amount != null ? String(Number(item.deposit_amount)) : '',
      condition: item.condition,
    });
  }

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Backpack className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Инвентарь</h1>
        </div>
        {!creating && (
          <button className="ds-btn ds-btn-primary flex items-center gap-1.5" onClick={() => { setCreating(true); setEditingId(null); }}>
            <Plus className="w-4 h-4" /> Добавить
          </button>
        )}
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {creating && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Новая позиция</p>
          <ItemForm
            form={createForm} setForm={setCreateForm}
            onSubmit={submitCreate} onCancel={() => setCreating(false)}
            submitLabel="Добавить" busy={busy}
          />
        </div>
      )}

      {items === null && !failed && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="ds-skeleton h-16 rounded-lg" />)}
        </div>
      )}

      {failed && <p className="text-sm text-[var(--danger)]">Не удалось загрузить инвентарь. Обновите страницу.</p>}

      {items !== null && items.length === 0 && !creating && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            В инвентаре пока пусто. Добавьте первую позицию — она появится на витрине аренды.
          </p>
        </div>
      )}

      {items !== null && items.map(item => (
        <div key={item.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{item.name}</p>
                {!item.is_active && (
                  <span className="ds-badge text-[var(--text-muted)] border border-[var(--border)]">Скрыто</span>
                )}
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {[CATEGORY_LABELS[item.category] ?? item.category, item.brand].filter(Boolean).join(' · ')}
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {formatMoney(item.price_per_day)}/день · доступно {item.available_quantity} из {item.quantity}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                aria-label={`Редактировать ${item.name}`}
                onClick={() => editingId === item.id ? setEditingId(null) : startEdit(item)}
                disabled={busy}>
                {editingId === item.id ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
              </button>
              <button
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                aria-label={item.is_active ? `Скрыть ${item.name}` : `Показать ${item.name}`}
                onClick={() => toggleActive(item)}
                disabled={busy}>
                {item.is_active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {editingId === item.id && (
            <div className="mt-4 pt-4 border-t border-[var(--border)]">
              <ItemForm
                form={editForm} setForm={setEditForm}
                onSubmit={submitEdit} onCancel={() => setEditingId(null)}
                submitLabel="Сохранить" busy={busy}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
