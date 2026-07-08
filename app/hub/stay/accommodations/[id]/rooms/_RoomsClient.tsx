'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BedDouble, Pencil, X, Plus, EyeOff, Eye, Trash2, ArrowLeft } from 'lucide-react';
import { ROOM_TYPES, ROOM_TYPE_LABELS, RoomType } from '@/lib/stay/room-types';

/**
 * Номера объекта размещения: список из GET /api/stay/accommodations/[id]/rooms,
 * создание (POST), правка и снятие с продажи (PATCH /api/stay/rooms/[id]),
 * удаление (DELETE; при активных бронях сервер отвечает 409).
 */

interface RoomRow {
  id: string;
  name: string;
  roomType: string;
  description: string | null;
  sizeSqm: number | null;
  maxGuests: number;
  availableRooms: number;
  pricePerNight: number;
  isActive: boolean;
  activeBookings: number;
}

interface RoomFormState {
  name: string;
  roomType: RoomType;
  description: string;
  sizeSqm: string;
  maxGuests: string;
  availableRooms: string;
  pricePerNight: string;
}

const EMPTY_FORM: RoomFormState = {
  name: '', roomType: 'double', description: '',
  sizeSqm: '', maxGuests: '2', availableRooms: '1', pricePerNight: '',
};

function formatMoney(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(v) + ' ₽';
}

export default function RoomsClient({ accommodationId }: { accommodationId: string }) {
  const [rooms, setRooms] = useState<RoomRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // editingId: null — форма закрыта; 'new' — создание; иначе id номера
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RoomFormState>(EMPTY_FORM);

  const load = useCallback(() => {
    fetch(`/api/stay/accommodations/${accommodationId}/rooms`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { rooms: RoomRow[] } } | null) => {
        if (d?.success && Array.isArray(d.data?.rooms)) setRooms(d.data.rooms);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [accommodationId]);

  useEffect(() => { load(); }, [load]);

  function startCreate() {
    setEditingId('new');
    setForm(EMPTY_FORM);
  }

  function startEdit(room: RoomRow) {
    setEditingId(room.id);
    setForm({
      name: room.name,
      roomType: (ROOM_TYPES as readonly string[]).includes(room.roomType) ? room.roomType as RoomType : 'double',
      description: room.description ?? '',
      sizeSqm: room.sizeSqm != null ? String(room.sizeSqm) : '',
      maxGuests: String(room.maxGuests),
      availableRooms: String(room.availableRooms),
      pricePerNight: String(room.pricePerNight),
    });
  }

  async function callApi(url: string, method: string, payload?: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const d = await res.json() as { success?: boolean; error?: string; message?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось выполнить операцию');
        return false;
      }
      load();
      return true;
    } catch {
      setError('Не удалось выполнить операцию');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitForm() {
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      roomType: form.roomType,
      maxGuests: Number(form.maxGuests),
      availableRooms: Number(form.availableRooms),
      pricePerNight: Number(form.pricePerNight),
    };
    if (form.description.trim()) payload.description = form.description.trim();
    if (form.sizeSqm) payload.sizeSqm = Number(form.sizeSqm);

    const ok = editingId === 'new'
      ? await callApi(`/api/stay/accommodations/${accommodationId}/rooms`, 'POST', payload)
      : await callApi(`/api/stay/rooms/${editingId}`, 'PATCH', payload);
    if (ok) setEditingId(null);
  }

  const formValid =
    form.name.trim().length > 0 &&
    Number(form.maxGuests) >= 1 &&
    Number(form.availableRooms) >= 0 &&
    Number(form.pricePerNight) > 0;

  const roomForm = (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="sm:col-span-2">
        <label className="ds-label">Название номера</label>
        <input className="ds-input" value={form.name} placeholder="Стандарт с видом на вулкан"
          onChange={e => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <label className="ds-label">Тип</label>
        <select className="ds-input" value={form.roomType}
          onChange={e => setForm({ ...form, roomType: e.target.value as RoomType })}>
          {ROOM_TYPES.map(t => <option key={t} value={t}>{ROOM_TYPE_LABELS[t]}</option>)}
        </select>
      </div>
      <div>
        <label className="ds-label">Площадь, м² (необязательно)</label>
        <input className="ds-input" type="number" min="1" value={form.sizeSqm}
          onChange={e => setForm({ ...form, sizeSqm: e.target.value })} />
      </div>
      <div>
        <label className="ds-label">Гостей максимум</label>
        <input className="ds-input" type="number" min="1" value={form.maxGuests}
          onChange={e => setForm({ ...form, maxGuests: e.target.value })} />
      </div>
      <div>
        <label className="ds-label">Таких номеров в объекте</label>
        <input className="ds-input" type="number" min="0" value={form.availableRooms}
          onChange={e => setForm({ ...form, availableRooms: e.target.value })} />
      </div>
      <div>
        <label className="ds-label">Цена, ₽/ночь</label>
        <input className="ds-input" type="number" min="1" value={form.pricePerNight}
          onChange={e => setForm({ ...form, pricePerNight: e.target.value })} />
      </div>
      <div className="sm:col-span-2">
        <label className="ds-label">Описание (необязательно)</label>
        <textarea className="ds-input" rows={2} value={form.description}
          onChange={e => setForm({ ...form, description: e.target.value })} />
      </div>
      <div className="sm:col-span-2 flex gap-2">
        <button className="ds-btn ds-btn-primary" onClick={submitForm} disabled={!formValid || busy}>
          {busy ? 'Сохранение…' : editingId === 'new' ? 'Создать номер' : 'Сохранить'}
        </button>
        <button className="ds-btn ds-btn-secondary" onClick={() => setEditingId(null)} disabled={busy}>
          Отмена
        </button>
      </div>
    </div>
  );

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Link href="/hub/stay/accommodations" aria-label="К списку объектов"
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <BedDouble className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Номера объекта</h1>
        </div>
        {editingId !== 'new' && (
          <button className="ds-btn ds-btn-primary text-xs" onClick={startCreate} disabled={busy}>
            <Plus className="w-3.5 h-3.5" /> Добавить номер
          </button>
        )}
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {editingId === 'new' && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm font-semibold text-[var(--text-primary)] mb-3">Новый номер</p>
          {roomForm}
        </div>
      )}

      {rooms === null && !failed && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="ds-skeleton h-20 rounded-lg" />)}
        </div>
      )}

      {failed && <p className="text-sm text-[var(--danger)]">Не удалось загрузить номера. Обновите страницу.</p>}

      {rooms !== null && rooms.length === 0 && editingId !== 'new' && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            Номеров пока нет. Добавьте первый — он появится на витрине объекта.
          </p>
        </div>
      )}

      {rooms !== null && rooms.map(room => (
        <div key={room.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{room.name}</p>
                {!room.isActive && (
                  <span className="ds-badge text-[var(--text-muted)] border border-[var(--border)]">Снят с продажи</span>
                )}
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {[
                  ROOM_TYPE_LABELS[room.roomType as RoomType] ?? room.roomType,
                  room.sizeSqm != null ? `${room.sizeSqm} м²` : null,
                  `до ${room.maxGuests} гостей`,
                  `в объекте: ${room.availableRooms}`,
                ].filter(Boolean).join(' · ')}
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {formatMoney(room.pricePerNight)}/ночь
                {room.activeBookings > 0 && (
                  <span className="text-[var(--warning)]"> · активных броней: {room.activeBookings}</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                aria-label={`Редактировать ${room.name}`}
                onClick={() => editingId === room.id ? setEditingId(null) : startEdit(room)}
                disabled={busy}>
                {editingId === room.id ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
              </button>
              <button
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                aria-label={room.isActive ? `Снять с продажи ${room.name}` : `Вернуть в продажу ${room.name}`}
                onClick={() => callApi(`/api/stay/rooms/${room.id}`, 'PATCH', { isActive: !room.isActive })}
                disabled={busy}>
                {room.isActive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
              <button
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--danger)] transition-colors"
                aria-label={`Удалить ${room.name}`}
                onClick={() => {
                  if (window.confirm(`Удалить номер «${room.name}»?`)) {
                    void callApi(`/api/stay/rooms/${room.id}`, 'DELETE');
                  }
                }}
                disabled={busy}>
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {editingId === room.id && (
            <div className="mt-4 pt-4 border-t border-[var(--border)]">
              {roomForm}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
