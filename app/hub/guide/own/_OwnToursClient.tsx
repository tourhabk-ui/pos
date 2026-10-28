'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Compass, CalendarPlus, Inbox, Loader2, AlertCircle, RefreshCw, Phone, Mail, Users } from 'lucide-react';
import { ALLOWED_TRANSITIONS } from '@/types/booking.types';
import type { OwnBooking, OwnLead, OwnTour } from '@/lib/guides/own-tours';

/**
 * «Свои туры» гида — туры, которые гид продаёт сам: брони по ним (подтвердить,
 * отклонить, отметить итог), заявки и открытие дат. Данные — GET
 * /api/guide/own; смена статуса — PATCH /api/guide/own/bookings/[id] (то же
 * правило, что у кабинета оператора); даты — POST /api/guide/own/dates.
 *
 * Список, который не прочитался, приходит null и показывается «не
 * загрузилось», а не «пусто» (§4.0).
 */
interface OwnData { tours: OwnTour[] | null; bookings: OwnBooking[] | null; leads: OwnLead[] | null }

type Action = 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export const STATUS_LABEL: Record<string, string> = {
  new: 'Новая — ждёт вашего ответа',
  pending_payment: 'Ждёт оплаты',
  confirmed: 'Подтверждена',
  cancelled: 'Отменена',
  completed: 'Завершена',
  no_show: 'Турист не пришёл',
};

const ACTION_LABEL: Record<Action, string> = {
  confirmed: 'Подтвердить',
  cancelled: 'Отклонить',
  completed: 'Тур прошёл',
  no_show: 'Не пришёл',
};

/** Кнопки по статусу — из тех же переходов, что проверяет сервер. */
export function actionsFor(status: string): Action[] {
  const allowed = (ALLOWED_TRANSITIONS as Record<string, readonly string[]>)[status] ?? [];
  return (['confirmed', 'completed', 'no_show', 'cancelled'] as const).filter((a) => allowed.includes(a));
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function fetchOwn(): Promise<{ data: OwnData | null; error: string | null }> {
  try {
    const res = await fetch('/api/guide/own', { cache: 'no-store' });
    const json = await res.json().catch(() => null) as { success?: boolean; data?: OwnData; error?: string } | null;
    if (!res.ok || !json?.success || !json.data) return { data: null, error: json?.error ?? 'Раздел не загрузился' };
    return { data: json.data, error: null };
  } catch {
    return { data: null, error: 'Сеть недоступна — раздел не загрузился' };
  }
}

function BookingRow({ b, onDone }: { b: OwnBooking; onDone: (msg: string) => void }) {
  const [pending, setPending] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (action: Action) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/guide/own/bookings/${b.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'cancelled' ? { booking_status: action, cancellation_reason: reason.trim() } : { booking_status: action }),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string; tourist_notice?: string | null } | null;
      if (!res.ok || !json?.success) { setError(json?.error ?? 'Не записано — попробуйте ещё раз'); return; }
      const mail = json.tourist_notice === 'no_email'
        ? ' У туриста нет почты — сообщите ему сами.'
        : json.tourist_notice && json.tourist_notice !== 'sent' ? ' Письмо туристу пока не ушло — повторим.' : '';
      setPending(null);
      onDone(`Бронь №${b.id}: ${STATUS_LABEL[action]?.toLowerCase() ?? action}.${mail}`);
    } catch {
      setError('Сеть недоступна — ничего не изменено');
    } finally {
      setBusy(false);
    }
  };

  const actions = actionsFor(b.booking_status);
  return (
    <li className="ds-card space-y-2" data-testid={`own-booking-${b.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-[var(--text-primary)]">{b.tour_title}</p>
        <span className="text-sm text-[var(--text-secondary)]">{STATUS_LABEL[b.booking_status] ?? b.booking_status}</span>
      </div>
      <p className="text-sm text-[var(--text-secondary)] flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>{fmtDate(b.booking_date)}</span>
        <span className="inline-flex items-center gap-1"><Users size={14} /> {b.participants}</span>
        {b.tourist_name && <span>{b.tourist_name}</span>}
        {b.tourist_phone && (
          <a href={`tel:${b.tourist_phone}`} className="inline-flex items-center gap-1 text-[var(--ocean)]"><Phone size={14} /> {b.tourist_phone}</a>
        )}
        {b.tourist_email && (
          <a href={`mailto:${b.tourist_email}`} className="inline-flex items-center gap-1 text-[var(--ocean)]"><Mail size={14} /> {b.tourist_email}</a>
        )}
      </p>
      {b.special_requests && <p className="text-sm text-[var(--text-muted)]">Пожелания: {b.special_requests}</p>}

      {pending ? (
        <div className="space-y-2">
          {pending === 'cancelled' && (
            <label className="block text-sm">
              <span className="text-[var(--text-secondary)]">Причина — её получит турист</span>
              <input className="ds-input mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} />
            </label>
          )}
          <p className="text-sm text-[var(--text-primary)]">
            {pending === 'confirmed'
              ? 'Подтвердить бронь? Турист получит письмо, что поездка состоится.'
              : pending === 'cancelled' ? 'Отклонить бронь? Турист получит письмо с причиной.' : `Отметить: ${ACTION_LABEL[pending].toLowerCase()}?`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ds-btn ds-btn-primary" disabled={busy || (pending === 'cancelled' && reason.trim().length === 0)}
              onClick={() => void send(pending)}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null} Да, {ACTION_LABEL[pending].toLowerCase()}
            </button>
            <button type="button" className="ds-btn ds-btn-secondary" disabled={busy} onClick={() => setPending(null)}>Назад</button>
          </div>
        </div>
      ) : actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <button key={a} type="button" className={`ds-btn ${a === 'confirmed' ? 'ds-btn-primary' : 'ds-btn-secondary'}`} onClick={() => setPending(a)}>
              {ACTION_LABEL[a]}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
    </li>
  );
}

function OpenDatesForm({ tours, onDone }: { tours: OwnTour[]; onDone: (msg: string) => void }) {
  const [tourId, setTourId] = useState(tours[0]?.id ?? '');
  const [startDate, setStart] = useState('');
  const [endDate, setEnd] = useState('');
  const [slots, setSlots] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/guide/own/dates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tourId, startDate, endDate: endDate || startDate, slots }),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; message?: string; error?: string } | null;
      if (!res.ok || !json?.success) { setError(json?.error ?? 'Даты не открыты'); return; }
      onDone(json.message ?? 'Даты открыты');
    } catch {
      setError('Сеть недоступна — даты не открыты');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ds-card space-y-3">
      <p className="text-sm text-[var(--text-secondary)]">
        Открытая дата видна туристу в календаре тура. Одна дата — заполните только «с».
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="text-[var(--text-secondary)]">Тур</span>
          <select className="ds-input mt-1 w-full" value={tourId} onChange={(e) => setTourId(e.target.value)}>
            {tours.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-[var(--text-secondary)]">С</span>
          <input type="date" className="ds-input mt-1 w-full" value={startDate} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--text-secondary)]">По</span>
          <input type="date" className="ds-input mt-1 w-full" value={endDate} min={startDate || undefined} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--text-secondary)]">Мест на дату</span>
          <input type="number" min={1} max={500} className="ds-input mt-1 w-full" value={slots} onChange={(e) => setSlots(Number(e.target.value))} />
        </label>
      </div>
      <button type="button" className="ds-btn ds-btn-primary" disabled={busy || !tourId || !startDate || slots < 1} onClick={() => void submit()}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <CalendarPlus size={14} />} Открыть даты
      </button>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
    </div>
  );
}

export default function OwnToursClient() {
  const [data, setData] = useState<OwnData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetchOwn();
    setData(r.data);
    setError(r.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchOwn().then((r) => {
      if (!alive) return;
      setData(r.data);
      setError(r.error);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const done = (msg: string) => { setNotice(msg); void load(); };

  const tours = data?.tours ?? null;
  const bookings = data?.bookings ?? null;
  const leads = data?.leads ?? null;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="ds-h1 flex items-center gap-2"><Compass className="w-6 h-6 text-[var(--ocean)]" /> Свои туры</h1>
        <button type="button" className="ds-btn ds-btn-secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} /> Обновить
        </button>
      </div>
      <p className="text-sm text-[var(--text-secondary)]">
        Туры, которые вы продаёте сами: брони и заявки туристов, ваши даты. Решение по брони — ваше; турист получит письмо.
      </p>
      {notice && <p role="status" className="ds-card text-sm text-[var(--text-primary)]">{notice}</p>}

      {loading && !data ? (
        <p className="text-[var(--text-secondary)] flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Загружаю…</p>
      ) : error ? (
        <p role="alert" className="ds-card text-[var(--danger)] flex items-center gap-2"><AlertCircle size={16} /> {error}</p>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="ds-h2">Брони</h2>
            {bookings === null ? (
              <p role="alert" className="text-sm text-[var(--danger)]">Брони не загрузились — обновите страницу.</p>
            ) : bookings.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">Броней пока нет.</p>
            ) : (
              <ul className="space-y-3">{bookings.map((b) => <BookingRow key={b.id} b={b} onDone={done} />)}</ul>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="ds-h2 flex items-center gap-2"><Inbox size={18} /> Заявки</h2>
            {leads === null ? (
              <p role="alert" className="text-sm text-[var(--danger)]">Заявки не загрузились — обновите страницу.</p>
            ) : leads.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">Заявок пока нет.</p>
            ) : (
              <ul className="space-y-3">
                {leads.map((l) => (
                  <li key={l.id} className="ds-card space-y-1 text-sm" data-testid={`own-lead-${l.id}`}>
                    <p className="text-[var(--text-primary)] font-medium">{l.name ?? 'Без имени'} · {fmtDate(l.created_at)}</p>
                    <p className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--text-secondary)]">
                      {l.phone && <a href={`tel:${l.phone}`} className="inline-flex items-center gap-1 text-[var(--ocean)]"><Phone size={14} /> {l.phone}</a>}
                      {l.email && <a href={`mailto:${l.email}`} className="inline-flex items-center gap-1 text-[var(--ocean)]"><Mail size={14} /> {l.email}</a>}
                      {l.desired_dates && <span>Даты: {l.desired_dates}</span>}
                      {l.group_size ? <span>Человек: {l.group_size}</span> : null}
                    </p>
                    {l.comment && <p className="text-[var(--text-muted)] whitespace-pre-line">{l.comment}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="ds-h2 flex items-center gap-2"><CalendarPlus size={18} /> Открыть даты</h2>
            {tours === null ? (
              <p role="alert" className="text-sm text-[var(--danger)]">Туры не загрузились — обновите страницу.</p>
            ) : tours.filter((t) => t.is_published && t.is_active).length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">
                Опубликованных туров нет. Туры без описания — черновики: пришлите описание менеджеру Ведара, и тур появится на сайте.
              </p>
            ) : (
              <OpenDatesForm tours={tours.filter((t) => t.is_published && t.is_active)} onDone={done} />
            )}
            {tours && tours.length > 0 && (
              <ul className="space-y-1 text-sm text-[var(--text-secondary)]">
                {tours.map((t) => (
                  <li key={t.id}>
                    {t.is_published
                      ? <Link href={`/catalog/tours/${t.id}`} className="text-[var(--ocean)]">{t.title}</Link>
                      : <span>{t.title}</span>}
                    {' — '}{t.is_published ? `открытых дат: ${t.open_dates}` : 'черновик, на сайте не виден'}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
