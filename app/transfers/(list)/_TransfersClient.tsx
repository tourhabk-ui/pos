'use client';

/**
 * /transfers — как доехать: машина целиком под заказ и места в поездках
 * перевозчиков (схема 926), мои заказы мест, оплата по QR.
 *
 * Порядок — от того, что есть, к тому, что бывает (владелец 13.10: «что за
 * поиск в трансфере… не понимаю смысл формы»). Первым экраном стояла форма
 * «с даты / по дату / мест нужно / Найти места», а мест в поездках на проде
 * не выставлял никто: форма всегда отвечала «никто не едет», а настоящее
 * предложение — вахтовка под заказ с ценой за машину — лежало ниже сгиба.
 * Теперь сверху вниз:
 *   1. Машина под заказ — прайс перевозчиков, цена за машину.
 *   2. Места в поездках — списком на 60 дней вперёд, без формы: угадывать
 *      даты не нужно, поездок мало. Ссылка из плана (lib/transfers/trips-link)
 *      открывает свои даты и свою поездку и даёт «показать все».
 *   3. Мои заказы мест — только когда они есть.
 *
 * У поездок три исхода (урок удалённого transfer-empty-state, 02.08): список /
 * пусто — словами / не смогли проверить — 503 от витрины, сказано прямо.
 * Пустой список без searched: true не выдаётся за «мест нет».
 *
 * Запрос мест — за входом (CHECK схемы 926 требует заказчика). Оплата — общий
 * SbpQrPayment со своими адресами (миграция 928): второй компонент QR
 * разошёлся бы поведением.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bus, CalendarDays, Users, AlertCircle, Loader2, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import SbpQrPayment from '@/components/marketplace/SbpQrPayment';
import { useAuth } from '@/contexts/AuthContext';
import { CharterCard } from '@/components/transfers/CharterCard';
import { platformAcceptsPayments } from '@/lib/payments/accepting';
import type { CharterState } from '@/lib/transfers/charter-format';
import type { TripsPrefill } from '@/lib/transfers/trips-link';

/** Насколько вперёд показываются поездки — потолок окна /api/carrier-trips. */
export const TRIPS_WINDOW_DAYS = 60;

interface Trip {
  id: string;
  trip_date: string;
  from_text: string;
  to_text: string;
  departure_note: string | null;
  seats_total: number;
  seats_free: number;
  price_per_seat: string | null;
  partner_name: string;
  vehicle_kind: string;
  vehicle_title: string;
}

interface MyBooking {
  id: string;
  trip_date: string;
  from_text: string;
  to_text: string;
  departure_note: string | null;
  partner_name: string;
  vehicle_title: string;
  seats: number;
  price: string | null;
  price_per_seat: string | null;
  status: 'requested' | 'confirmed' | 'declined' | 'cancelled';
  decline_reason: string | null;
  payment_status: 'unpaid' | 'pending' | 'paid';
  /** Отзыв о перевозчике: ссылка, когда поездка дала на него право (1235). */
  review_href?: string | null;
  reviewed?: boolean;
}

type Trips =
  | { state: 'loading' }
  | { state: 'ok'; trips: Trip[] }
  | { state: 'failed'; message: string };

type Mine =
  | { state: 'idle' }
  | { state: 'ok'; bookings: MyBooking[] }
  | { state: 'failed'; message: string };

/** Какие поездки показаны: ближайшие 60 дней или даты из ссылки плана. */
interface TripsWindow { from: string; to: string; seats: number; fromPlan: boolean }

const KIND_LABEL: Record<string, string> = { jeep: 'джип', vahtovka: 'вахтовка', minibus: 'микроавтобус', other: 'транспорт' };

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDate(s: string): string {
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}
function money(v: string | null): string | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toLocaleString('ru-RU')} ₽` : null;
}
function amountOf(b: MyBooking): number | null {
  if (b.price !== null) return Number(b.price);
  if (b.price_per_seat !== null) return Number(b.price_per_seat) * b.seats;
  return null;
}

async function fetchTrips(w: TripsWindow): Promise<Trips> {
  try {
    const qs = new URLSearchParams({ from: w.from, to: w.to, min_seats: String(w.seats) });
    const res = await fetch(`/api/carrier-trips?${qs}`);
    const body = (await res.json().catch(() => null)) as
      | { success: boolean; searched?: boolean; trips?: Trip[]; error?: string }
      | null;
    if (!res.ok || !body?.success || body.searched !== true || !body.trips) {
      return { state: 'failed', message: body?.error ?? 'Не удалось проверить поездки — попробуйте позже.' };
    }
    return { state: 'ok', trips: body.trips };
  } catch {
    return { state: 'failed', message: 'Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.' };
  }
}

async function fetchMine(): Promise<Mine> {
  try {
    const res = await fetch('/api/carrier-trips/bookings', { credentials: 'include' });
    const body = (await res.json().catch(() => null)) as
      | { success: boolean; searched?: boolean; bookings?: MyBooking[]; error?: string }
      | null;
    if (!res.ok || !body?.success || body.searched !== true || !body.bookings) {
      return { state: 'failed', message: body?.error ?? 'Не удалось проверить заказы — попробуйте позже' };
    }
    return { state: 'ok', bookings: body.bookings };
  } catch {
    return { state: 'failed', message: 'Нет связи с сервером.' };
  }
}

export default function TransfersClient({ charter, prefill = null, today = new Date().toISOString().slice(0, 10) }: {
  charter: CharterState;
  prefill?: TripsPrefill | null;
  /** Сегодня по Камчатке, ГГГГ-ММ-ДД — передаёт сервер. */
  today?: string;
}) {
  const { user, isLoading: authLoading } = useAuth();
  const nextDays: TripsWindow = { from: today, to: addDays(today, TRIPS_WINDOW_DAYS), seats: 1, fromPlan: false };
  const [win, setWin] = useState<TripsWindow>(
    prefill ? { from: prefill.from, to: prefill.to, seats: prefill.seats, fromPlan: true } : nextDays,
  );
  const [trips, setTrips] = useState<Trips>({ state: 'loading' });
  const [mine, setMine] = useState<Mine>({ state: 'idle' });
  const [payingId, setPayingId] = useState<string | null>(null);
  // Номер перечитки: запрос мест или оплата меняют остаток и статус заказа.
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    void fetchTrips(win).then((t) => { if (!cancelled) setTrips(t); });
    return () => { cancelled = true; };
  }, [win, tick]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void fetchMine().then((m) => { if (!cancelled) setMine(m); });
    return () => { cancelled = true; };
  }, [user, tick]);

  // Поездка, ради которой пришли из плана: карточка в поле зрения.
  const focusTripId = prefill?.tripId ?? null;
  useEffect(() => {
    if (!focusTripId || trips.state !== 'ok') return;
    document.getElementById(`trip-${focusTripId}`)?.scrollIntoView({ block: 'center' });
  }, [focusTripId, trips.state]);

  const showAllTrips = () => {
    setTrips({ state: 'loading' });
    setWin(nextDays);
  };

  const hasTrips = trips.state === 'ok' && trips.trips.length > 0;
  const showMine = !!user && (mine.state === 'failed' || (mine.state === 'ok' && mine.bookings.length > 0));

  return (
    <div className="ds-page" style={{ paddingBottom: 96 }}>
      <Header />
      <main className="mx-auto max-w-2xl px-5 pt-6">
        {/* SOS — в общей шапке (Header, §2), своей копии рядом с заголовком нет. */}
        {/* Шапка — по образцу каталога туров (владелец 12.10): заголовок 28px
            на телефоне, одна строка сути, подробности — только с sm. */}
        <div className="mb-6">
          <p className="ds-label mb-1 sm:mb-2">Перевозчики</p>
          <h1 className="font-playfair text-[28px] sm:text-4xl font-bold text-[var(--text-primary)] leading-tight mb-1 sm:mb-2">Трансферы</h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-md">
            Машина целиком под заказ — по прайсу перевозчика, цена за машину.
            <span className="hidden sm:inline">
              {' '}Ниже — места в поездках: когда машина уже идёт на дату, перевозчик выставляет свободные места.
            </span>
          </p>
        </div>

        {/* 1. Машина под заказ: прайс перевозчика, дат и мест здесь нет */}
        <section aria-labelledby="charter-title" className="mb-10">
          <h2 id="charter-title" className="ds-h2 mb-3">Машина под заказ</h2>
          {charter.state === 'failed' ? (
            <div className="ds-card p-4 flex items-start gap-2 border-[var(--warning)]">
              <AlertCircle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm text-[var(--text-primary)]">Не смогли проверить вахтовки под заказ</p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">Сбой на нашей стороне. Это не значит, что их нет — загляните позже.</p>
              </div>
            </div>
          ) : charter.carriers.length > 0 ? (
            <div className="flex flex-col gap-4">
              {charter.carriers.map(c => <CharterCard key={c.partnerId} carrier={c} />)}
            </div>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">Перевозчиков с прайсом под заказ пока нет.</p>
          )}
        </section>

        {/* 2. Места в поездках: списком, без формы дат */}
        <section aria-labelledby="trips-title" className="mb-10">
          <h2 id="trips-title" className="ds-h2 mb-1">Места в поездках</h2>
          <p className="text-sm text-[var(--text-secondary)] mb-3">
            Когда машина уже идёт на дату и в ней остались места, перевозчик выставляет их сюда. Место закрепляется после его подтверждения.
          </p>
          {win.fromPlan && (
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-xs text-[var(--text-secondary)]">
                Поездки на ваши даты: {fmtDate(win.from)}{win.to !== win.from ? ` — ${fmtDate(win.to)}` : ''}{win.seats > 1 ? `, мест от ${win.seats}` : ''}
              </p>
              <button type="button" onClick={showAllTrips} className="text-xs text-[var(--ocean)] hover:underline min-h-[44px]">
                Все поездки на {TRIPS_WINDOW_DAYS} дней
              </button>
            </div>
          )}
          {trips.state === 'loading' && (
            <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]" role="status">
              <Loader2 size={16} className="animate-spin" aria-hidden /> Проверяем поездки…
            </p>
          )}
          {trips.state === 'failed' && (
            <div className="ds-card p-4 flex items-start gap-2 border-[var(--warning)]">
              <AlertCircle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm text-[var(--text-primary)]">Не смогли проверить поездки</p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">{trips.message} Это не значит, что мест нет.</p>
              </div>
            </div>
          )}
          {trips.state === 'ok' && trips.trips.length === 0 && (
            <p className="text-sm text-[var(--text-secondary)]" data-testid="trips-empty">
              {win.fromPlan
                ? 'На эти даты мест в поездках никто не выставил.'
                : `В ближайшие ${TRIPS_WINDOW_DAYS} дней мест в поездках никто не выставил. Нужна машина — закажите её целиком выше.`}
            </p>
          )}
          {hasTrips && trips.state === 'ok' && (
            <ul className="flex flex-col gap-3">
              {trips.trips.map(t => (
                <li key={t.id} id={`trip-${t.id}`}
                  className={t.id === focusTripId ? 'rounded-lg ring-2 ring-[var(--accent)]' : undefined}>
                  <TripCard trip={t} authed={!!user} authLoading={authLoading} onRequested={reload} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 3. Мои заказы мест — только когда есть что показать */}
        {showMine && (
          <section aria-labelledby="mine-title" className="mb-8">
            <h2 id="mine-title" className="ds-h2 mb-3">Мои заказы мест</h2>
            {mine.state === 'failed' && (
              <p className="text-sm text-[var(--text-secondary)]">Не смогли проверить заказы: {mine.message}</p>
            )}
            {mine.state === 'ok' && (
              <ul className="flex flex-col gap-3">
                {mine.bookings.map(b => (
                  <li key={b.id} className="ds-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[var(--text-primary)]">{b.from_text} — {b.to_text}</p>
                        <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                          {fmtDate(b.trip_date)}{b.departure_note ? `, ${b.departure_note}` : ''} · {b.partner_name} · {b.vehicle_title} · мест: {b.seats}
                        </p>
                      </div>
                      <BookingBadge b={b} />
                    </div>
                    {b.status === 'declined' && b.decline_reason && (
                      <p className="text-xs text-[var(--text-secondary)] mt-2">Причина: {b.decline_reason}</p>
                    )}
                    {b.review_href ? (
                      <Link href={b.review_href} className="inline-flex items-center min-h-[44px] text-sm text-[var(--ocean)] hover:underline mt-1">
                        Оставить отзыв о перевозчике
                      </Link>
                    ) : b.reviewed ? (
                      <p className="text-xs text-[var(--text-muted)] mt-2">Отзыв о поездке оставлен — спасибо.</p>
                    ) : null}
                    {b.status === 'confirmed' && b.payment_status !== 'paid' && (
                      <div className="mt-3">
                        {!platformAcceptsPayments() ? (
                          <p className="text-xs text-[var(--text-secondary)]">Оплата — перевозчику напрямую: Ведар платежи не принимает. Перевозчик свяжется с вами.</p>
                        ) : amountOf(b) === null ? (
                          <p className="text-xs text-[var(--text-secondary)]">Перевозчик ещё не назвал цену — оплата появится после этого.</p>
                        ) : payingId === b.id || b.payment_status === 'pending' ? (
                          <SbpQrPayment
                            bookingId={b.id}
                            amount={amountOf(b) ?? 0}
                            api={{ issue: `/api/carrier-trips/bookings/${b.id}/qr`, status: `/api/carrier-trips/bookings/${b.id}/qr` }}
                            unavailableHint="Оплата по СБП сейчас недоступна — договоритесь с перевозчиком напрямую."
                            onPaid={() => { setPayingId(null); reload(); }}
                          />
                        ) : (
                          <button className="ds-btn ds-btn-primary text-sm" onClick={() => setPayingId(b.id)}>
                            Оплатить по QR СБП · {money(String(amountOf(b)))}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
      <BottomNav activePath="/transfers" />
    </div>
  );
}

function BookingBadge({ b }: { b: MyBooking }) {
  if (b.status === 'requested') return <span className="ds-badge flex items-center gap-1"><Clock size={12} /> ждёт перевозчика</span>;
  if (b.status === 'declined') return <span className="ds-badge flex items-center gap-1"><XCircle size={12} /> отказ</span>;
  if (b.status === 'cancelled') return <span className="ds-badge">отменён</span>;
  if (b.payment_status === 'paid') return <span className="ds-badge flex items-center gap-1 text-[var(--success)]"><CheckCircle2 size={12} /> оплачен</span>;
  return <span className="ds-badge flex items-center gap-1 text-[var(--success)]"><CheckCircle2 size={12} /> подтверждён</span>;
}

function TripCard({ trip, authed, authLoading, onRequested }: { trip: Trip; authed: boolean; authLoading: boolean; onRequested: () => void }) {
  const [open, setOpen] = useState(false);
  const [seats, setSeats] = useState(1);
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const submit = async () => {
    setBusy(true); setNote(null);
    try {
      const res = await fetch(`/api/carrier-trips/${trip.id}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ seats, contact_phone: phone, comment: comment || null }),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; error?: string; note?: string } | null;
      if (!res.ok || !body?.success) {
        setNote({ kind: 'err', text: body?.error ?? 'Не удалось отправить запрос' });
        return;
      }
      setNote({ kind: 'ok', text: body.note ?? 'Запрос отправлен перевозчику' });
      setOpen(false);
      onRequested();
    } catch {
      setNote({ kind: 'err', text: 'Нет связи с сервером' });
    } finally { setBusy(false); }
  };

  const price = money(trip.price_per_seat);
  return (
    <div className="ds-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--text-primary)]">{trip.from_text} — {trip.to_text}</p>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5 flex items-center gap-1.5 flex-wrap">
            <CalendarDays size={12} className="text-[var(--ocean)]" /> {fmtDate(trip.trip_date)}{trip.departure_note ? `, ${trip.departure_note}` : ''}
            <span aria-hidden>·</span>
            <Bus size={12} className="text-[var(--ocean)]" /> {KIND_LABEL[trip.vehicle_kind] ?? trip.vehicle_kind}, {trip.vehicle_title}
          </p>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">{trip.partner_name}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-1 justify-end"><Users size={14} className="text-[var(--ocean)]" /> {trip.seats_free} из {trip.seats_total}</p>
          <p className="text-xs text-[var(--text-secondary)]">{price ? `${price} за место` : 'цена по запросу'}</p>
        </div>
      </div>

      {note && (
        <p className={`text-xs mt-2 ${note.kind === 'ok' ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{note.text}</p>
      )}

      {!open ? (
        <div className="mt-3">
          {authed ? (
            <button className="ds-btn ds-btn-secondary text-sm" onClick={() => setOpen(true)}>Запросить места</button>
          ) : (
            <Link href="/auth/login?from=/transfers" className="ds-btn ds-btn-secondary text-sm inline-flex" aria-disabled={authLoading}>
              Войти, чтобы запросить места
            </Link>
          )}
        </div>
      ) : (
        <form className="mt-3 grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="text-xs text-[var(--text-secondary)]">
            Мест
            <input type="number" min={1} max={trip.seats_free} className="ds-input mt-1 w-full" value={seats} onChange={e => setSeats(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            Телефон для связи
            <input type="tel" className="ds-input mt-1 w-full" value={phone} onChange={e => setPhone(e.target.value)} required minLength={5} placeholder="+7…" />
          </label>
          <label className="text-xs text-[var(--text-secondary)] col-span-2">
            Комментарий (необязательно)
            <input type="text" className="ds-input mt-1 w-full" value={comment} onChange={e => setComment(e.target.value)} maxLength={500} placeholder="Где забрать, багаж, дети" />
          </label>
          <div className="col-span-2 flex gap-2">
            <button type="submit" className="ds-btn ds-btn-primary text-sm" disabled={busy}>{busy ? 'Отправляем…' : 'Отправить запрос'}</button>
            <button type="button" className="ds-btn ds-btn-secondary text-sm" onClick={() => setOpen(false)}>Отмена</button>
          </div>
          <p className="col-span-2 text-xs text-[var(--text-muted)]">Запрос ничего не держит: место займётся, когда перевозчик подтвердит и назовёт цену.</p>
        </form>
      )}
    </div>
  );
}
