'use client';

/**
 * Витрина мест в поездках перевозчиков (схема 926) + мои заказы + оплата по QR.
 *
 * Три состояния поиска, а не два (урок удалённого transfer-empty-state, 02.08):
 *   · ещё не искали — форма и приглашение;
 *   · искали, нашли ноль — сказано словами и предложены другие даты;
 *   · не смогли проверить — 503 от витрины, экран говорит это прямо.
 * Пустой список никогда не выдаётся за «никто не едет» без searched: true.
 *
 * Запрос мест — за входом (CHECK схемы 926 требует заказчика). Оплата — общий
 * SbpQrPayment со своими адресами (миграция 928): второй компонент QR
 * разошёлся бы поведением.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Bus, CalendarDays, Users, AlertCircle, Loader2, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import EmergencyAction from '@/components/shared/EmergencyAction';
import SbpQrPayment from '@/components/marketplace/SbpQrPayment';
import { useAuth } from '@/contexts/AuthContext';

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
}

type Search =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; trips: Trip[]; window: { from: string; to: string } }
  | { state: 'failed'; message: string };

type Mine =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; bookings: MyBooking[] }
  | { state: 'failed'; message: string };

const KIND_LABEL: Record<string, string> = { jeep: 'джип', vahtovka: 'вахтовка', minibus: 'микроавтобус', other: 'транспорт' };

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function fmtDate(s: string): string {
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
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

export default function TransfersClient() {
  const { user, isLoading: authLoading } = useAuth();
  const today = new Date();
  const [from, setFrom] = useState(isoDate(today));
  const [to, setTo] = useState(isoDate(new Date(today.getTime() + 14 * 86_400_000)));
  const [minSeats, setMinSeats] = useState(1);
  const [search, setSearch] = useState<Search>({ state: 'idle' });
  const [mine, setMine] = useState<Mine>({ state: 'idle' });
  const [payingId, setPayingId] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    setSearch({ state: 'loading' });
    try {
      const qs = new URLSearchParams({ from, to, min_seats: String(minSeats) });
      const res = await fetch(`/api/carrier-trips?${qs}`);
      const body = (await res.json().catch(() => null)) as
        | { success: boolean; searched?: boolean; trips?: Trip[]; window?: { from: string; to: string }; error?: string }
        | null;
      if (!res.ok || !body?.success || body.searched !== true || !body.trips || !body.window) {
        setSearch({ state: 'failed', message: body?.error ?? 'Не удалось проверить поездки — попробуйте позже' });
        return;
      }
      setSearch({ state: 'ok', trips: body.trips, window: body.window });
    } catch {
      setSearch({ state: 'failed', message: 'Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.' });
    }
  }, [from, to, minSeats]);

  const loadMine = useCallback(async () => {
    setMine({ state: 'loading' });
    try {
      const res = await fetch('/api/carrier-trips/bookings', { credentials: 'include' });
      const body = (await res.json().catch(() => null)) as
        | { success: boolean; searched?: boolean; bookings?: MyBooking[]; error?: string }
        | null;
      if (!res.ok || !body?.success || body.searched !== true || !body.bookings) {
        setMine({ state: 'failed', message: body?.error ?? 'Не удалось проверить заказы — попробуйте позже' });
        return;
      }
      setMine({ state: 'ok', bookings: body.bookings });
    } catch {
      setMine({ state: 'failed', message: 'Нет связи с сервером.' });
    }
  }, []);

  useEffect(() => { void runSearch(); /* окно по умолчанию — сразу, чтобы экран не был пустым */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (user) void loadMine(); }, [user, loadMine]);

  return (
    <div className="ds-page" style={{ paddingBottom: 96 }}>
      <Header />
      <main className="mx-auto max-w-2xl px-5 pt-6">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <p className="ds-label mb-2">Перевозчики</p>
            <h1 className="ds-h1 mb-2">Места в поездках</h1>
            <p className="text-sm text-[var(--text-secondary)] max-w-md">
              Джипы и вахтовки идут под заказ. Когда места остаются, перевозчик выставляет их сюда.
              Место занимается только после его подтверждения.
            </p>
          </div>
          <EmergencyAction />
        </div>

        {/* Поиск */}
        <form
          className="ds-card p-4 mb-6 grid grid-cols-2 gap-3"
          onSubmit={(e) => { e.preventDefault(); void runSearch(); }}
        >
          <label className="text-xs text-[var(--text-secondary)]">
            С даты
            <input type="date" className="ds-input mt-1 w-full" value={from} onChange={e => setFrom(e.target.value)} required />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            По дату
            <input type="date" className="ds-input mt-1 w-full" value={to} onChange={e => setTo(e.target.value)} required />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">
            Мест нужно
            <input type="number" min={1} max={60} className="ds-input mt-1 w-full" value={minSeats} onChange={e => setMinSeats(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <div className="flex items-end">
            <button type="submit" className="ds-btn ds-btn-primary w-full" disabled={search.state === 'loading'}>
              {search.state === 'loading' ? 'Ищем…' : 'Найти места'}
            </button>
          </div>
        </form>

        {/* Три состояния поиска */}
        {search.state === 'idle' && (
          <p className="text-sm text-[var(--text-muted)] mb-8">Выберите даты — покажем, кто едет и сколько мест свободно.</p>
        )}
        {search.state === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-8"><Loader2 size={16} className="animate-spin" /> Проверяем поездки…</div>
        )}
        {search.state === 'failed' && (
          <div className="ds-card p-4 mb-8 flex items-start gap-2 border-[var(--warning)]">
            <AlertCircle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-[var(--text-primary)]">Не смогли проверить поездки</p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">{search.message} Это не значит, что мест нет.</p>
            </div>
          </div>
        )}
        {search.state === 'ok' && search.trips.length === 0 && (
          <div className="ds-card p-5 mb-8">
            <p className="text-sm text-[var(--text-primary)] font-semibold mb-1">
              С {fmtDate(search.window.from)} по {fmtDate(search.window.to)} никто не едет
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Мы искали и не нашли ни одной опубликованной поездки с таким остатком мест. Попробуйте другие даты или меньше мест.
            </p>
          </div>
        )}
        {search.state === 'ok' && search.trips.length > 0 && (
          <ul className="flex flex-col gap-3 mb-8">
            {search.trips.map(t => (
              <li key={t.id}>
                <TripCard
                  trip={t}
                  authed={!!user}
                  authLoading={authLoading}
                  onRequested={() => { void loadMine(); void runSearch(); }}
                />
              </li>
            ))}
          </ul>
        )}

        {/* Мои заказы */}
        {user && (
          <section className="mb-8">
            <h2 className="ds-h2 mb-3">Мои заказы мест</h2>
            {mine.state === 'loading' && <p className="text-sm text-[var(--text-muted)]">Проверяем…</p>}
            {mine.state === 'failed' && (
              <p className="text-sm text-[var(--text-secondary)]">Не смогли проверить заказы: {mine.message}</p>
            )}
            {mine.state === 'ok' && mine.bookings.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">Заказов пока нет.</p>
            )}
            {mine.state === 'ok' && mine.bookings.length > 0 && (
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
                    {b.status === 'confirmed' && b.payment_status !== 'paid' && (
                      <div className="mt-3">
                        {amountOf(b) === null ? (
                          <p className="text-xs text-[var(--text-secondary)]">Перевозчик ещё не назвал цену — оплата появится после этого.</p>
                        ) : payingId === b.id || b.payment_status === 'pending' ? (
                          <SbpQrPayment
                            bookingId={b.id}
                            amount={amountOf(b) ?? 0}
                            api={{ issue: `/api/carrier-trips/bookings/${b.id}/qr`, status: `/api/carrier-trips/bookings/${b.id}/qr` }}
                            unavailableHint="Оплата по СБП сейчас недоступна — договоритесь с перевозчиком напрямую."
                            onPaid={() => { setPayingId(null); void loadMine(); }}
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
        {!user && !authLoading && (
          <p className="text-xs text-[var(--text-muted)] mb-8">
            <Link href="/auth/login?from=/transfers" className="text-[var(--ocean)] underline">Войдите</Link>, чтобы запросить места и видеть свои заказы.
          </p>
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
