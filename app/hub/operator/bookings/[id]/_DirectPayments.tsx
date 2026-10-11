'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Banknote, Plus, X } from 'lucide-react';
import {
  DIRECT_PAYMENT_METHODS, DIRECT_PAYMENT_METHOD_LABELS, type DirectPaymentMethod, type DirectPaymentRow,
} from '@/lib/bookings/direct-payment-kinds';

/**
 * Оплата напрямую оператору (CRM фаза 2в). Деньги, которые турист отдал
 * оператору сам — наличными, переводом, по терминалу. Это НЕ оплата через
 * платформу: статус оплаты брони, выплаты и комиссия от этих записей не
 * зависят (решение владельца 11.10).
 */

interface Summary {
  payments: DirectPaymentRow[];
  paid: number;
  final_price: number | null;
  remaining: number | null;
}

const fetcher = async (url: string): Promise<Summary> => {
  const r = await fetch(url);
  const j = await r.json().catch(() => null) as { success?: boolean; data?: Summary; error?: string } | null;
  if (!r.ok || !j?.success || !j.data) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j.data;
};

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
const ruDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const todayKamchatka = () => new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 10);

const INPUT = 'px-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors w-full';

export default function DirectPayments({ bookingId }: { bookingId: string }) {
  const url = `/api/hub/operator/bookings/${bookingId}/direct-payments`;
  const { data, error, mutate } = useSWR<Summary>(url, fetcher);
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<DirectPaymentMethod>('cash');
  const [receivedOn, setReceivedOn] = useState(todayKamchatka);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const save = async () => {
    const n = Number(amount.replace(',', '.').replace(/\s/g, ''));
    if (!Number.isFinite(n) || n <= 0) { setFormError('Укажите сумму больше нуля'); return; }
    setBusy(true); setFormError('');
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: n, method, received_on: receivedOn, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const j = await r.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!r.ok || !j?.success) { setFormError(j?.error ?? `Не записано (HTTP ${r.status})`); return; }
      setAdding(false); setAmount(''); setNote('');
      await mutate();
    } catch {
      setFormError('Нет связи — оплата не записана');
    } finally {
      setBusy(false);
    }
  };

  const voidPayment = async (p: DirectPaymentRow) => {
    const reason = window.prompt(`Аннулировать запись ${rub(p.amount)}? Укажите причину (например, «ошибка в сумме»):`);
    if (reason === null) return;
    if (reason.trim().length < 3) { setFormError('Причина аннулирования — хотя бы несколько слов'); return; }
    setBusy(true); setFormError('');
    try {
      const r = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_id: p.id, reason: reason.trim() }),
      });
      const j = await r.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!r.ok || !j?.success) { setFormError(j?.error ?? `Не аннулировано (HTTP ${r.status})`); return; }
      await mutate();
    } catch {
      setFormError('Нет связи — запись не аннулирована');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ds-card p-5 mb-6">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide flex items-center gap-2">
          <Banknote className="w-4 h-4" /> Оплата напрямую
        </h2>
        {!adding && (
          <button type="button" onClick={() => { setAdding(true); setFormError(''); }} className="ds-btn text-sm gap-1.5">
            <Plus className="w-4 h-4" /> Записать оплату
          </button>
        )}
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-4">
        Деньги, которые турист отдал вам сам: наличными, переводом, по терминалу. Это не оплата через платформу — комиссии и выплаты по ним нет.
      </p>

      {error && <p className="text-sm text-[var(--danger)]">Оплаты не загрузились — обновите страницу.</p>}

      {data && (
        <p className="text-sm text-[var(--text-primary)] mb-3">
          Получено <span className="font-semibold">{rub(data.paid)}</span>
          {data.final_price !== null
            ? <> из {rub(data.final_price)} · осталось <span className="font-semibold">{rub(data.remaining ?? 0)}</span></>
            : <span className="text-[var(--text-muted)]"> · цена брони не записана</span>}
        </p>
      )}

      {data && data.payments.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {data.payments.map(p => (
            <li key={p.id} className={`flex items-start justify-between gap-3 text-sm ${p.voided_at ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)]'}`}>
              <span>
                {ruDate(p.received_on)} · {rub(p.amount)} {DIRECT_PAYMENT_METHOD_LABELS[p.method]}
                {p.note ? ` · ${p.note}` : ''}
                {p.voided_at && <span className="no-underline"> · аннулировано: {p.void_reason}</span>}
              </span>
              {!p.voided_at && (
                <button type="button" onClick={() => voidPayment(p)} disabled={busy}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--danger)] shrink-0" aria-label="Аннулировать запись">
                  <X className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-[var(--border)] pt-3">
          <label className="space-y-1">
            <span className="text-xs text-[var(--text-muted)]">Сумма, ₽ *</span>
            <input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} className={INPUT} placeholder="30000" />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-[var(--text-muted)]">Способ</span>
            <select value={method} onChange={e => setMethod(e.target.value as DirectPaymentMethod)} className={INPUT}>
              {DIRECT_PAYMENT_METHODS.map(m => <option key={m} value={m}>{DIRECT_PAYMENT_METHOD_LABELS[m]}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-[var(--text-muted)]">Когда получены</span>
            <input type="date" value={receivedOn} max={todayKamchatka()} onChange={e => setReceivedOn(e.target.value)} className={INPUT} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-[var(--text-muted)]">Примечание</span>
            <input value={note} onChange={e => setNote(e.target.value)} maxLength={500} className={INPUT} placeholder="Предоплата 30%" />
          </label>
          {formError && <p className="sm:col-span-2 text-sm text-[var(--danger)]">{formError}</p>}
          <div className="sm:col-span-2 flex gap-2">
            <button type="button" onClick={save} disabled={busy} className="ds-btn ds-btn-primary text-sm">Записать</button>
            <button type="button" onClick={() => { setAdding(false); setFormError(''); }} className="ds-btn text-sm">Отмена</button>
          </div>
        </div>
      )}
      {!adding && formError && <p className="text-sm text-[var(--danger)]">{formError}</p>}
    </div>
  );
}
