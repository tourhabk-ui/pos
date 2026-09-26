'use client';

/**
 * Брони агента: продажи по ссылке и брони, оформленные за клиента.
 *
 * С 26.09 бронь за клиента — обычная бронь оператора (reserveBooking):
 * оператор её видит и подтверждает, после чего клиент платит по ссылке,
 * которую агент ему пересылает. Отсюда три вещи на экране:
 *   - выбор тура — из ВСЕХ опубликованных туров, дата — календарём свободных
 *     дат тура (TourDateField). Прежний список брал слоты только на сегодня
 *     (find-tours без дат) и только у операторов с календарём;
 *   - после создания — ссылка для клиента с кнопкой «Скопировать»;
 *   - отказ загрузки — сообщение, а не пустой список (§4.0).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Handshake, Plus, Loader2, AlertTriangle, Copy, Check, Link2, UserRound,
} from 'lucide-react';
import Link from 'next/link';
import TourDateField from '@/components/marketplace/TourDateField';
import { bookingTotal, normalizePriceUnit } from '@/lib/tours/booking-total';
import { PRICE_UNIT_SHORT } from '@/lib/tours/labels';

interface AgentSale {
  id: string;
  path: 'client' | 'link';
  tourTitle: string;
  tourDate: string;
  endDate: string | null;
  participants: number;
  totalPrice: number | null;
  status: string;
  paymentStatus: string | null;
  paid: boolean;
  awaitingPayment: boolean;
  clientId: string | null;
  clientName: string | null;
  touristLink: string | null;
  createdAt: string;
}

interface ClientOption { id: string; name: string; phone?: string }

interface TourOption {
  id: string;
  name: string;
  price: number;
  priceUnit: string;
  durationHours: number | null;
  multiDayCount: number | null;
  maxGroupSize: number | null;
  operatorName: string | null;
}

interface Created { bookingId: number; totalPrice: number; touristLink: string }

const INPUT = 'w-full px-3 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

const STATUS_LABEL: Record<string, string> = {
  new:             'Ждёт подтверждения оператора',
  confirmed:       'Подтверждена оператором',
  pending_payment: 'Оплата начата',
  completed:       'Состоялась',
  cancelled:       'Отменена',
  rejected:        'Отклонена оператором',
};

function fmtRub(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
}

function fmtDate(d: string): string {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function paymentLabel(s: AgentSale): string {
  if (s.paid) return 'Оплачена';
  if (s.status === 'cancelled' || s.status === 'rejected') return '—';
  if (s.awaitingPayment) return 'Ждёт оплаты клиентом';
  return 'Оплата после подтверждения';
}

async function readJson(res: Response): Promise<{ success?: boolean; data?: unknown; error?: string; message?: string }> {
  try {
    const j: unknown = await res.json();
    return typeof j === 'object' && j !== null ? j as Record<string, never> : {};
  } catch {
    return {};
  }
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[agent/bookings] ссылка не скопирована', err);
      setFailed(true);
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-stretch gap-2">
        <input readOnly value={link} className={`${INPUT} font-mono text-xs`} onFocus={e => e.currentTarget.select()} aria-label="Ссылка для клиента" />
        <button
          type="button"
          onClick={copy}
          className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap text-sm"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Скопировано' : 'Скопировать'}
        </button>
      </div>
      {failed && (
        <p className="text-xs text-[var(--danger)]">Не удалось скопировать — выделите ссылку и скопируйте вручную.</p>
      )}
    </div>
  );
}

export default function AgentBookingsPageClient() {
  // Фильтр по клиенту и предзаполнение формы — из адреса (кнопка «Бронирования»
  // у клиента, «Оформить за клиента» в поиске туров). Читается на клиенте.
  const [clientFilter, setClientFilter] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ tour: string; date: string } | null>(null);

  const [sales, setSales] = useState<AgentSale[]>([]);
  const [salesLoading, setSalesLoading] = useState(true);
  const [salesError, setSalesError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [clientId, setClientId] = useState('');
  const [tourId, setTourId] = useState('');
  const [date, setDate] = useState('');
  const [guests, setGuests] = useState('1');
  const [requests, setRequests] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [tours, setTours] = useState<TourOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsLoaded, setOptionsLoaded] = useState(false);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const c = sp.get('clientId');
      if (c) { setClientFilter(c); setClientId(c); }
      const t = sp.get('tour');
      const d = sp.get('date');
      if (t && /^\d+$/.test(t)) {
        setPrefill({ tour: t, date: d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '' });
        setShowForm(true);
      }
    } catch (err) {
      console.error('[agent/bookings] параметры адреса не прочитаны', err);
    }
  }, []);

  const loadSales = useCallback(async (filter: string | null) => {
    setSalesLoading(true);
    setSalesError(null);
    try {
      const qs = filter ? `?clientId=${encodeURIComponent(filter)}` : '';
      const res = await fetch(`/api/agent/bookings${qs}`);
      const j = await readJson(res);
      const list = (j.data as { bookings?: AgentSale[] } | undefined)?.bookings;
      if (!res.ok || !j.success || !Array.isArray(list)) {
        setSalesError(j.error ?? 'Не удалось загрузить брони');
        return;
      }
      setSales(list);
    } catch (err) {
      console.error('[agent/bookings] список не загружен', err);
      setSalesError('Не удалось загрузить брони — проверьте соединение');
    } finally {
      setSalesLoading(false);
    }
  }, []);

  useEffect(() => { void loadSales(clientFilter); }, [clientFilter, loadSales]);

  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    setOptionsError(null);
    try {
      const [cr, tr] = await Promise.all([fetch('/api/agent/clients?limit=200'), fetch('/api/agent/tours')]);
      const [cj, tj] = await Promise.all([readJson(cr), readJson(tr)]);
      const cl = (cj.data as { clients?: ClientOption[] } | undefined)?.clients;
      const tl = (tj.data as { tours?: TourOption[] } | undefined)?.tours;
      if (!cr.ok || !cj.success || !Array.isArray(cl)) {
        setOptionsError(cj.error ?? 'Не удалось загрузить клиентов');
        return;
      }
      if (!tr.ok || !tj.success || !Array.isArray(tl)) {
        setOptionsError(tj.error ?? 'Не удалось загрузить туры');
        return;
      }
      setClients(cl.map(c => ({ id: c.id, name: c.name, phone: c.phone })));
      setTours(tl);
      setOptionsLoaded(true);
    } catch (err) {
      console.error('[agent/bookings] справочники не загружены', err);
      setOptionsError('Не удалось загрузить клиентов и туры — проверьте соединение');
    } finally {
      setOptionsLoading(false);
    }
  }, []);

  // Справочники — при первом открытии формы, не на каждый рендер списка.
  useEffect(() => {
    if (showForm && !optionsLoaded && !optionsLoading && !optionsError) void loadOptions();
  }, [showForm, optionsLoaded, optionsLoading, optionsError, loadOptions]);

  // Предзаполнение из поиска туров — когда туры уже загружены.
  useEffect(() => {
    if (!prefill || tours.length === 0) return;
    if (tours.some(t => t.id === prefill.tour)) {
      setTourId(prefill.tour);
      if (prefill.date) setDate(prefill.date);
    }
    setPrefill(null);
  }, [prefill, tours]);

  const tour = tours.find(t => t.id === tourId) ?? null;
  const participants = Math.max(1, parseInt(guests, 10) || 1);
  const duration = tour ? { multi_day_count: tour.multiDayCount, duration_hours: tour.durationHours } : undefined;
  const estimate = tour ? bookingTotal({ basePrice: tour.price, priceUnit: tour.priceUnit, participants, duration }) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!clientId) { setFormError('Выберите клиента'); return; }
    if (!tourId) { setFormError('Выберите тур'); return; }
    if (!date) { setFormError('Выберите дату тура'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/agent/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          tourId: Number(tourId),
          tourDate: date,
          guestsCount: participants,
          ...(requests.trim() ? { specialRequests: requests.trim() } : {}),
        }),
      });
      const j = await readJson(res);
      const d = j.data as Created | undefined;
      if (!res.ok || !j.success || !d?.touristLink) {
        setFormError(j.error ?? 'Не удалось создать бронь');
        return;
      }
      setCreated(d);
      setShowForm(false);
      setTourId('');
      setDate('');
      setGuests('1');
      setRequests('');
      await loadSales(clientFilter);
    } catch (err) {
      console.error('[agent/bookings] бронь не отправлена', err);
      setFormError('Не удалось создать бронь — проверьте соединение');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="ds-h1 flex items-center gap-2">
          <Handshake className="w-6 h-6 text-[var(--ocean)]" />
          Бронирования
        </h1>
        <button
          type="button"
          onClick={() => { setShowForm(s => !s); setCreated(null); }}
          className="ds-btn ds-btn-primary inline-flex items-center gap-2 text-sm"
        >
          <Plus className="w-4 h-4" />
          Бронь за клиента
        </button>
      </div>

      <p className="text-sm text-[var(--text-secondary)]">
        Здесь брони, оформленные вами за клиентов, и брони туристов, пришедших по вашей ссылке.
        Оператор подтверждает каждую бронь, после этого клиент оплачивает её сам.
      </p>

      {created && (
        <div className="ds-card p-4 space-y-3 border-[var(--success)]" role="status">
          <p className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Check className="w-4 h-4 text-[var(--success)]" />
            Заявка №{created.bookingId} отправлена оператору · {fmtRub(created.totalPrice)}
          </p>
          <p className="text-sm text-[var(--text-secondary)]">
            Оператор подтвердит бронь, после этого клиент оплатит по ссылке. Отправьте ссылку клиенту —
            по ней он увидит заявку, её статус и оплатит, когда оператор подтвердит.
          </p>
          <CopyLink link={created.touristLink} />
        </div>
      )}

      {showForm && (
        <form onSubmit={submit} className="ds-card p-4 space-y-4">
          {optionsLoading ? (
            <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <Loader2 className="w-4 h-4 animate-spin" /> Загружаем клиентов и туры…
            </p>
          ) : optionsError ? (
            <div role="alert" className="flex items-start gap-2 text-sm text-[var(--danger)]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-2">
                <p>{optionsError}</p>
                <button type="button" onClick={() => void loadOptions()} className="ds-btn ds-btn-secondary text-sm">
                  Повторить
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="ab-client" className="ds-label">Клиент</label>
                <select id="ab-client" required value={clientId} onChange={e => setClientId(e.target.value)} className={INPUT}>
                  <option value="">— выберите клиента —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>)}
                </select>
                {clients.length === 0 && (
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    Клиентов пока нет — <Link href="/hub/agent/clients" className="text-[var(--ocean)] hover:underline">добавьте клиента</Link> с именем и телефоном.
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="ab-tour" className="ds-label">Тур</label>
                <select id="ab-tour" required value={tourId} onChange={e => { setTourId(e.target.value); setDate(''); }} className={INPUT}>
                  <option value="">— выберите тур —</option>
                  {tours.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {fmtRub(t.price)} {PRICE_UNIT_SHORT[normalizePriceUnit(t.priceUnit)]}
                    </option>
                  ))}
                </select>
                {tours.length === 0 && (
                  <p className="text-xs text-[var(--text-muted)] mt-1">Опубликованных туров сейчас нет.</p>
                )}
              </div>
              {tour && (
                <div className="sm:col-span-2">
                  <span className="ds-label">Дата тура</span>
                  <TourDateField tourId={Number(tour.id)} tourTitle={tour.name} value={date} onChange={setDate} inputId="ab-date" />
                </div>
              )}
              <div>
                <label htmlFor="ab-guests" className="ds-label">Участников</label>
                <input
                  id="ab-guests" required type="number" min={1} max={tour?.maxGroupSize ?? 100}
                  value={guests} onChange={e => setGuests(e.target.value)} className={INPUT}
                />
              </div>
              <div>
                <span className="ds-label">Сумма заявки</span>
                <p className="py-2.5 text-sm text-[var(--text-primary)]">
                  {estimate != null ? fmtRub(estimate) : '—'}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  Ставку вашего вознаграждения назначает платформа.
                </p>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="ab-requests" className="ds-label">Пожелания оператору (необязательно)</label>
                <textarea id="ab-requests" rows={2} maxLength={2000} value={requests} onChange={e => setRequests(e.target.value)} className={`${INPUT} resize-none`} />
              </div>
            </div>
          )}
          {formError && (
            <p role="alert" className="flex items-start gap-2 text-sm text-[var(--danger)]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {formError}
            </p>
          )}
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowForm(false); setFormError(null); }} className="ds-btn ds-btn-secondary text-sm">
              Отмена
            </button>
            <button type="submit" disabled={saving || optionsLoading || !!optionsError} className="ds-btn ds-btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Отправить оператору
            </button>
          </div>
        </form>
      )}

      {clientFilter && (
        <p className="text-sm text-[var(--text-secondary)]">
          Показаны брони одного клиента.{' '}
          <button type="button" className="text-[var(--ocean)] hover:underline" onClick={() => setClientFilter(null)}>
            Показать все
          </button>
        </p>
      )}

      {salesLoading ? (
        <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Loader2 className="w-4 h-4 animate-spin" /> Загрузка…
        </p>
      ) : salesError ? (
        <div role="alert" className="ds-card p-4 flex items-start gap-2 text-sm text-[var(--danger)]">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p>{salesError}</p>
            <button type="button" onClick={() => void loadSales(clientFilter)} className="ds-btn ds-btn-secondary text-sm">
              Повторить
            </button>
          </div>
        </div>
      ) : sales.length === 0 ? (
        <div className="ds-card p-6 text-center text-sm text-[var(--text-secondary)]">
          Броней пока нет. Оформите бронь за клиента или поделитесь своей ссылкой в разделе «Реферальные ссылки».
        </div>
      ) : (
        <ul className="space-y-3">
          {sales.map(s => (
            <li key={s.id} className="ds-card p-4 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-[var(--text-primary)]">{s.tourTitle}</p>
                  <p className="text-sm text-[var(--text-secondary)]">
                    {fmtDate(s.tourDate)}{s.endDate && s.endDate !== s.tourDate ? ` — ${fmtDate(s.endDate)}` : ''} · {s.participants} чел.
                    {s.totalPrice != null ? ` · ${fmtRub(s.totalPrice)}` : ''}
                  </p>
                </div>
                <span className="ds-badge text-xs">
                  {s.path === 'client'
                    ? <span className="inline-flex items-center gap-1"><UserRound className="w-3 h-3" />{s.clientName ?? 'Клиент'}</span>
                    : <span className="inline-flex items-center gap-1"><Link2 className="w-3 h-3" />По вашей ссылке</span>}
                </span>
              </div>
              <p className="text-sm text-[var(--text-primary)]">
                {STATUS_LABEL[s.status] ?? s.status} · <span className="text-[var(--text-secondary)]">{paymentLabel(s)}</span>
              </p>
              {s.touristLink && !s.paid && s.status !== 'cancelled' && s.status !== 'rejected' && (
                <CopyLink link={s.touristLink} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
