'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Home, Pencil, EyeOff, Eye, X, Star, BedDouble, Image as ImageIcon } from 'lucide-react';
import { ACCOMMODATION_TYPE_LABELS } from '@/lib/stay/accommodation-types';

/**
 * Объекты владельца жилья: список из GET /api/stay/accommodations
 * (включая снятые с публикации), редактирование и переключатель
 * публикации — через PATCH /api/accommodations/[id].
 * Создание — в онбординге (/hub/stay/onboarding, POST /api/stay/accommodations).
 */

const TYPE_LABELS: Record<string, string> = ACCOMMODATION_TYPE_LABELS;

interface AccommodationRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
  short_description: string | null;
  address: string;
  total_rooms: number;
  check_in_time: string | null;
  check_out_time: string | null;
  price_per_night_from: string | number;
  price_per_night_to: string | number | null;
  rating: string | number | null;
  review_count: number;
  is_active: boolean;
  is_verified: boolean;
  rooms_count: string | number;
  pending_bookings: string | number;
}

interface EditFormState {
  name: string;
  shortDescription: string;
  description: string;
  pricePerNightFrom: string;
  pricePerNightTo: string;
  checkInTime: string;
  checkOutTime: string;
}

function formatMoney(v: string | number): string {
  return new Intl.NumberFormat('ru-RU').format(Number(v)) + ' ₽';
}

// TIME из БД приходит как "14:00:00" — форме и API нужен формат ЧЧ:ММ
function toHHMM(t: string | null): string {
  return t ? t.slice(0, 5) : '';
}

export default function AccommodationsClient() {
  const [items, setItems] = useState<AccommodationRow[] | null>(null);
  const [noProfile, setNoProfile] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditFormState>({
    name: '', shortDescription: '', description: '',
    pricePerNightFrom: '', pricePerNightTo: '', checkInTime: '', checkOutTime: '',
  });

  const load = useCallback(() => {
    fetch('/api/stay/accommodations')
      .then(r => {
        if (r.status === 404) {
          setNoProfile(true);
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((d: { success?: boolean; data?: { accommodations: AccommodationRow[] } } | null) => {
        if (d === null) return;
        if (d?.success && Array.isArray(d.data?.accommodations)) setItems(d.data.accommodations);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  function startEdit(item: AccommodationRow) {
    setEditingId(item.id);
    setForm({
      name: item.name,
      shortDescription: item.short_description ?? '',
      description: item.description ?? '',
      pricePerNightFrom: String(Number(item.price_per_night_from)),
      pricePerNightTo: item.price_per_night_to != null ? String(Number(item.price_per_night_to)) : '',
      checkInTime: toHHMM(item.check_in_time),
      checkOutTime: toHHMM(item.check_out_time),
    });
  }

  async function patchAccommodation(id: string, payload: Record<string, unknown>, failMessage: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/accommodations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || failMessage);
        return false;
      }
      load();
      return true;
    } catch {
      setError(failMessage);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit() {
    if (!editingId) return;
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      pricePerNightFrom: Number(form.pricePerNightFrom),
    };
    if (form.shortDescription.trim()) payload.shortDescription = form.shortDescription.trim();
    if (form.description.trim()) payload.description = form.description.trim();
    payload.pricePerNightTo = form.pricePerNightTo ? Number(form.pricePerNightTo) : null;
    if (form.checkInTime) payload.checkInTime = form.checkInTime;
    if (form.checkOutTime) payload.checkOutTime = form.checkOutTime;

    const ok = await patchAccommodation(editingId, payload, 'Не удалось сохранить изменения');
    if (ok) setEditingId(null);
  }

  const formValid = form.name.trim().length > 0 && Number(form.pricePerNightFrom) > 0;

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <Home className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Мои объекты</h1>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {noProfile && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center max-w-lg">
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Кабинет ещё не настроен — заполните профиль и добавьте первый объект.
          </p>
          <Link href="/hub/stay/onboarding" className="ds-btn ds-btn-primary">Настроить кабинет</Link>
        </div>
      )}

      {items === null && !failed && !noProfile && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="ds-skeleton h-24 rounded-lg" />)}
        </div>
      )}

      {failed && <p className="text-sm text-[var(--danger)]">Не удалось загрузить объекты. Обновите страницу.</p>}

      {items !== null && items.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Объектов пока нет — добавьте первый, и он появится на витрине после проверки.
          </p>
          <Link href="/hub/stay/onboarding" className="ds-btn ds-btn-primary">Добавить объект</Link>
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
                {item.is_verified && (
                  <span className="ds-badge text-[var(--success)] border border-[var(--border)]">Проверено</span>
                )}
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {[TYPE_LABELS[item.type] ?? item.type, item.address].filter(Boolean).join(' · ')}
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                от {formatMoney(item.price_per_night_from)}/ночь
                {item.price_per_night_to != null && ` до ${formatMoney(item.price_per_night_to)}`}
                {' · '}номеров: {item.total_rooms}
                {Number(item.pending_bookings) > 0 && (
                  <span className="text-[var(--warning)]"> · новых броней: {Number(item.pending_bookings)}</span>
                )}
              </p>
              {Number(item.review_count) > 0 && (
                <p className="text-xs text-[var(--text-secondary)] mt-1 flex items-center gap-1">
                  <Star className="w-3 h-3 text-[var(--warning)]" />
                  {Number(item.rating ?? 0).toFixed(1)} · {item.review_count} отзывов
                </p>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Link
                href={`/hub/stay/accommodations/${item.id}/rooms`}
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                aria-label={`Номера ${item.name}`}>
                <BedDouble className="w-4 h-4" />
              </Link>
              <Link
                href={`/hub/stay/accommodations/${item.id}/photos`}
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                aria-label={`Фото ${item.name}`}>
                <ImageIcon className="w-4 h-4" />
              </Link>
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
                onClick={() => patchAccommodation(item.id, { isActive: !item.is_active }, 'Не удалось изменить статус публикации')}
                disabled={busy}>
                {item.is_active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {editingId === item.id && (
            <div className="mt-4 pt-4 border-t border-[var(--border)] grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="ds-label">Название</label>
                <input className="ds-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <label className="ds-label">Цена от, ₽/ночь</label>
                <input className="ds-input" type="number" min="1" value={form.pricePerNightFrom} onChange={e => setForm({ ...form, pricePerNightFrom: e.target.value })} />
              </div>
              <div>
                <label className="ds-label">Цена до, ₽/ночь (необязательно)</label>
                <input className="ds-input" type="number" min="1" value={form.pricePerNightTo} onChange={e => setForm({ ...form, pricePerNightTo: e.target.value })} />
              </div>
              <div>
                <label className="ds-label">Заезд с</label>
                <input className="ds-input" type="time" value={form.checkInTime} onChange={e => setForm({ ...form, checkInTime: e.target.value })} />
              </div>
              <div>
                <label className="ds-label">Выезд до</label>
                <input className="ds-input" type="time" value={form.checkOutTime} onChange={e => setForm({ ...form, checkOutTime: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <label className="ds-label">Короткое описание</label>
                <input className="ds-input" value={form.shortDescription} onChange={e => setForm({ ...form, shortDescription: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <label className="ds-label">Описание</label>
                <textarea className="ds-input" rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
              </div>
              <div className="sm:col-span-2 flex gap-2">
                <button className="ds-btn ds-btn-primary" onClick={submitEdit} disabled={!formValid || busy}>
                  {busy ? 'Сохранение…' : 'Сохранить'}
                </button>
                <button className="ds-btn ds-btn-secondary" onClick={() => setEditingId(null)} disabled={busy}>Отмена</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
