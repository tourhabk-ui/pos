'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Бронь своего тура рукой гида-продавца (#3211): по звонку или из заявки.
 * Сервер — `POST /api/guide/own/bookings` (общее правило ручной брони
 * продавца, lib/bookings/manual-booking).
 *
 * Из заявки форма берёт только то, что заявка записала: контакты, число
 * людей, тур и дату заявки на тур. Чего нет — поле пустое, а не догадка.
 * Бронь записывается подтверждённой; туристу ничего не отправляется — это
 * сказано под кнопкой, как и то, что заявка станет «Договорились».
 */
export interface BookingFormTour {
  id: string;
  title: string;
  is_published: boolean;
  is_active: boolean;
}

export interface BookingFormLead {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  people: number | null;
  tour_id: string | null;
  requested_date: string | null;
}

interface Props {
  tours: BookingFormTour[];
  lead?: BookingFormLead | null;
  onDone: (msg: string) => void;
  onCancel: () => void;
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function ManualBookingForm({ tours, lead = null, onDone, onCancel }: Props) {
  const leadTour = lead?.tour_id && tours.some((t) => t.id === lead.tour_id) ? lead.tour_id : null;
  const [tourId, setTourId] = useState(leadTour ?? tours[0]?.id ?? '');
  const [date, setDate] = useState(lead?.requested_date ?? '');
  const [people, setPeople] = useState(lead?.people && lead.people > 0 ? String(lead.people) : '');
  const [name, setName] = useState(lead?.name ?? '');
  const [phone, setPhone] = useState(lead?.phone ?? '');
  const [email, setEmail] = useState(lead?.email ?? '');
  const [price, setPrice] = useState('');
  const [wishes, setWishes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = Number(people);
  const ready = Boolean(tourId) && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isInteger(n) && n >= 1;
  const prefix = lead ? `lead-${lead.id}` : 'manual';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        operator_tour_id: Number(tourId),
        booking_date: date,
        participants: n,
      };
      if (name.trim()) body.tourist_name = name.trim();
      if (phone.trim()) body.tourist_phone = phone.trim();
      if (email.trim()) body.tourist_email = email.trim();
      if (price.trim()) body.final_price = Number(price);
      if (wishes.trim()) body.special_requests = wishes.trim();
      if (lead) body.lead_id = lead.id;
      const res = await fetch('/api/guide/own/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string; data?: { id?: string } } | null;
      if (!res.ok || !json?.success) { setError(json?.error ?? 'Бронь не записана — попробуйте ещё раз'); return; }
      const title = tours.find((t) => t.id === tourId)?.title ?? 'тур';
      onDone(`Бронь №${json.data?.id ?? '—'} записана: ${title}, ${fmtDate(date)}, ${n} чел.${lead ? ' Заявка — «Договорились».' : ''}`);
    } catch {
      setError('Сеть недоступна — бронь не записана');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ds-card space-y-3" data-testid={`booking-form-${prefix}`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="text-[var(--text-secondary)]">Тур</span>
          <select className="ds-input mt-1 w-full" value={tourId} onChange={(e) => setTourId(e.target.value)}>
            {tours.map((t) => (
              <option key={t.id} value={t.id}>{t.title}{t.is_published && t.is_active ? '' : ' (черновик)'}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-[var(--text-secondary)]">Дата поездки</span>
          <input type="date" className="ds-input mt-1 w-full" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--text-secondary)]">Человек</span>
          <input type="number" min={1} max={100} inputMode="numeric" className="ds-input mt-1 w-full" value={people}
            onChange={(e) => setPeople(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--text-secondary)]">Имя туриста</span>
          <input className="ds-input mt-1 w-full" value={name} maxLength={255} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--text-secondary)]">Телефон</span>
          <input type="tel" className="ds-input mt-1 w-full" value={phone} maxLength={20} autoComplete="off" onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--text-secondary)]">Почта</span>
          <input type="email" className="ds-input mt-1 w-full" value={email} maxLength={255} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--text-secondary)]">Цена брони, ₽</span>
          <input type="number" min={0} inputMode="numeric" className="ds-input mt-1 w-full" value={price} placeholder="по цене тура"
            onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-[var(--text-secondary)]">Пожелания</span>
          <textarea className="ds-input mt-1 w-full" rows={2} value={wishes} maxLength={1000} onChange={(e) => setWishes(e.target.value)} />
        </label>
      </div>
      <p className="text-sm text-[var(--text-secondary)]">
        Бронь запишется подтверждённой; туристу ничего не отправляется.
        {lead ? ' Заявка станет «Договорились» и уйдёт из «Входящих».' : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ds-btn ds-btn-primary" disabled={busy || !ready} onClick={() => void submit()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : null} Записать бронь
        </button>
        <button type="button" className="ds-btn ds-btn-secondary" disabled={busy} onClick={onCancel}>Назад</button>
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
    </div>
  );
}
