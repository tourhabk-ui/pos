'use client';

/**
 * Кабинет перевозчика (схема 926): парк, поездки, запросы мест.
 *
 * Каждый список — три состояния: загружаем / есть / не смогли прочитать.
 * Ошибки API показываются словами сервера (у исходов есть имена: day_taken,
 * seats_over_capacity, not_enough_seats…), а не «что-то пошло не так».
 * Записи — только через /api/hub/carrier/* (requireCarrier), напрямую в
 * таблицы этот экран не ходит.
 */
import { useCallback, useEffect, useState } from 'react';
import { Truck, CalendarDays, Inbox, Plus, Eye, EyeOff, Check, X, AlertCircle } from 'lucide-react';

type Tab = 'trips' | 'requests' | 'fleet';

interface Vehicle { id: string; kind: string; title: string; seats: number; notes: string | null; is_active: boolean }
interface Trip {
  id: string; vehicle_id: string; trip_date: string; from_text: string; to_text: string;
  departure_note: string | null; seats_total: number; price_per_seat: string | null;
  is_published: boolean; status: string; vehicle_title: string; seats_taken: number; seats_free: number; seats_requested: number;
}
interface SeatRequest {
  id: string; trip_id: string; seats: number; price: string | null; status: string; comment: string | null;
  contact_phone: string | null; trip_date: string; from_text: string; to_text: string; vehicle_title: string;
  ordered_by_partner_name: string | null;
}

type Load<T> = { state: 'loading' } | { state: 'ok'; items: T[] } | { state: 'failed'; message: string };

const KIND_LABEL: Record<string, string> = { jeep: 'Джип', vahtovka: 'Вахтовка', minibus: 'Микроавтобус', other: 'Другое' };

async function readJson<T>(res: Response): Promise<{ ok: boolean; data?: T; error?: string }> {
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null;
  if (!res.ok || !body?.success) return { ok: false, error: body?.error ?? `Ошибка ${res.status}` };
  return { ok: true, data: body.data };
}

function fmtDate(s: string): string {
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export default function CarrierClient() {
  const [tab, setTab] = useState<Tab>('trips');
  const [vehicles, setVehicles] = useState<Load<Vehicle>>({ state: 'loading' });
  const [trips, setTrips] = useState<Load<Trip>>({ state: 'loading' });
  const [requests, setRequests] = useState<Load<SeatRequest>>({ state: 'loading' });
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async <T,>(url: string, set: (v: Load<T>) => void) => {
    set({ state: 'loading' });
    try {
      const r = await readJson<T[]>(await fetch(url, { credentials: 'include' }));
      set(r.ok && r.data ? { state: 'ok', items: r.data } : { state: 'failed', message: r.error ?? 'не прочитали' });
    } catch {
      set({ state: 'failed', message: 'нет связи с сервером' });
    }
  }, []);

  const reloadAll = useCallback(() => {
    void load<Vehicle>('/api/hub/carrier/vehicles', setVehicles);
    void load<Trip>('/api/hub/carrier/trips', setTrips);
    void load<SeatRequest>('/api/hub/carrier/requests?status=requested', setRequests);
  }, [load]);

  useEffect(() => { reloadAll(); }, [reloadAll]);

  const say = (kind: 'ok' | 'err', text: string) => { setFlash({ kind, text }); setTimeout(() => setFlash(null), 6000); };

  const pendingCount = requests.state === 'ok' ? requests.items.length : null;

  return (
    <div className="p-5 lg:p-6 max-w-3xl">
      <p className="ds-label mb-1">Перевозчик</p>
      <h1 className="ds-h1 mb-4">Кабинет</h1>

      <div className="flex gap-2 mb-5 flex-wrap">
        <TabButton active={tab === 'trips'} onClick={() => setTab('trips')} icon={<CalendarDays size={14} />} label="Поездки" />
        <TabButton active={tab === 'requests'} onClick={() => setTab('requests')} icon={<Inbox size={14} />} label={pendingCount ? `Запросы · ${pendingCount}` : 'Запросы'} />
        <TabButton active={tab === 'fleet'} onClick={() => setTab('fleet')} icon={<Truck size={14} />} label="Парк" />
      </div>

      {flash && (
        <p className={`text-sm mb-4 ${flash.kind === 'ok' ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{flash.text}</p>
      )}

      {tab === 'fleet' && <Fleet vehicles={vehicles} onChanged={reloadAll} say={say} />}
      {tab === 'trips' && <Trips trips={trips} vehicles={vehicles} onChanged={reloadAll} say={say} />}
      {tab === 'requests' && <Requests requests={requests} onChanged={reloadAll} say={say} />}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`ds-btn text-sm flex items-center gap-1.5 ${active ? 'ds-btn-primary' : 'ds-btn-secondary'}`}
    >
      {icon} {label}
    </button>
  );
}

function Failed({ what, message }: { what: string; message: string }) {
  return (
    <div className="ds-card p-4 flex items-start gap-2 border-[var(--warning)]">
      <AlertCircle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" />
      <p className="text-sm text-[var(--text-secondary)]">Не смогли прочитать {what}: {message}. Это не значит, что их нет.</p>
    </div>
  );
}

// ── Парк ────────────────────────────────────────────────────────────────────

function Fleet({ vehicles, onChanged, say }: { vehicles: Load<Vehicle>; onChanged: () => void; say: (k: 'ok' | 'err', t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('jeep');
  const [title, setTitle] = useState('');
  const [seats, setSeats] = useState(6);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await readJson(await fetch('/api/hub/carrier/vehicles', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, title, seats, notes: notes || null }),
      }));
      if (!r.ok) { say('err', r.error ?? 'Машина не добавлена'); return; }
      say('ok', 'Машина добавлена'); setOpen(false); setTitle(''); setNotes(''); onChanged();
    } finally { setBusy(false); }
  };

  return (
    <section>
      {vehicles.state === 'loading' && <p className="text-sm text-[var(--text-muted)]">Читаем парк…</p>}
      {vehicles.state === 'failed' && <Failed what="парк" message={vehicles.message} />}
      {vehicles.state === 'ok' && vehicles.items.length === 0 && (
        <p className="text-sm text-[var(--text-secondary)] mb-3">Машин пока нет. Добавьте первую — без неё поездку не завести.</p>
      )}
      {vehicles.state === 'ok' && vehicles.items.length > 0 && (
        <ul className="flex flex-col gap-2 mb-4">
          {vehicles.items.map(v => (
            <li key={v.id} className="ds-card p-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[var(--text-primary)]">{v.title}</p>
                <p className="text-xs text-[var(--text-secondary)]">{KIND_LABEL[v.kind] ?? v.kind} · мест: {v.seats}{v.notes ? ` · ${v.notes}` : ''}</p>
              </div>
              {!v.is_active && <span className="ds-badge">не активна</span>}
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <button className="ds-btn ds-btn-secondary text-sm flex items-center gap-1.5" onClick={() => setOpen(true)}><Plus size={14} /> Добавить машину</button>
      ) : (
        <form className="ds-card p-4 grid grid-cols-2 gap-3" onSubmit={e => { e.preventDefault(); void submit(); }}>
          <label className="text-xs text-[var(--text-secondary)]">Тип
            <select className="ds-input mt-1 w-full" value={kind} onChange={e => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="text-xs text-[var(--text-secondary)]">Мест
            <input type="number" min={1} max={60} className="ds-input mt-1 w-full" value={seats} onChange={e => setSeats(Number(e.target.value) || 1)} />
          </label>
          <label className="text-xs text-[var(--text-secondary)] col-span-2">Название
            <input className="ds-input mt-1 w-full" value={title} onChange={e => setTitle(e.target.value)} required minLength={2} maxLength={100} placeholder="Например, КАМАЗ-вахтовка 4310" />
          </label>
          <label className="text-xs text-[var(--text-secondary)] col-span-2">Заметка
            <input className="ds-input mt-1 w-full" value={notes} onChange={e => setNotes(e.target.value)} maxLength={300} placeholder="Лебёдка, рация, детские кресла" />
          </label>
          <div className="col-span-2 flex gap-2">
            <button type="submit" className="ds-btn ds-btn-primary text-sm" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
            <button type="button" className="ds-btn ds-btn-secondary text-sm" onClick={() => setOpen(false)}>Отмена</button>
          </div>
        </form>
      )}
    </section>
  );
}

// ── Поездки ─────────────────────────────────────────────────────────────────

function Trips({ trips, vehicles, onChanged, say }: { trips: Load<Trip>; vehicles: Load<Vehicle>; onChanged: () => void; say: (k: 'ok' | 'err', t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [date, setDate] = useState('');
  const [fromText, setFromText] = useState('Петропавловск-Камчатский');
  const [toText, setToText] = useState('');
  const [note, setNote] = useState('');
  const [seatsTotal, setSeatsTotal] = useState(1);
  const [price, setPrice] = useState('');
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);

  const vehicleList = vehicles.state === 'ok' ? vehicles.items.filter(v => v.is_active) : [];

  const submit = async () => {
    setBusy(true);
    try {
      const r = await readJson(await fetch('/api/hub/carrier/trips', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicle_id: vehicleId, trip_date: date, from_text: fromText, to_text: toText,
          departure_note: note || null, seats_total: seatsTotal,
          price_per_seat: price ? Number(price) : null, is_published: publish,
        }),
      }));
      if (!r.ok) { say('err', r.error ?? 'Поездка не создана'); return; }
      say('ok', publish ? 'Поездка создана и выставлена в витрину' : 'Поездка создана'); setOpen(false); setToText(''); onChanged();
    } finally { setBusy(false); }
  };

  const togglePublish = async (t: Trip) => {
    const r = await readJson(await fetch(`/api/hub/carrier/trips/${t.id}/publish`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ published: !t.is_published }),
    }));
    if (!r.ok) { say('err', r.error ?? 'Не удалось'); return; }
    say('ok', t.is_published ? 'Снято с витрины' : 'Выставлено в витрину'); onChanged();
  };

  return (
    <section>
      {trips.state === 'loading' && <p className="text-sm text-[var(--text-muted)]">Читаем поездки…</p>}
      {trips.state === 'failed' && <Failed what="поездки" message={trips.message} />}
      {trips.state === 'ok' && trips.items.length === 0 && (
        <p className="text-sm text-[var(--text-secondary)] mb-3">Поездок пока нет. Поездка — это машина, день и направление под заказ.</p>
      )}
      {trips.state === 'ok' && trips.items.length > 0 && (
        <ul className="flex flex-col gap-2 mb-4">
          {trips.items.map(t => (
            <li key={t.id} className="ds-card p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{fmtDate(t.trip_date)} · {t.from_text} — {t.to_text}</p>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {t.vehicle_title}{t.departure_note ? ` · ${t.departure_note}` : ''} · занято {t.seats_taken} из {t.seats_total}, свободно {t.seats_free}
                    {t.seats_requested > 0 ? `, запрошено ${t.seats_requested}` : ''}
                    {t.price_per_seat ? ` · ${Number(t.price_per_seat).toLocaleString('ru-RU')} ₽ за место` : ' · цена места не назначена'}
                  </p>
                </div>
                <button
                  className="ds-btn ds-btn-secondary text-xs flex items-center gap-1 shrink-0"
                  onClick={() => void togglePublish(t)}
                  title={t.is_published ? 'Снять с витрины' : 'Выставить в витрину'}
                >
                  {t.is_published ? <><Eye size={12} /> в витрине</> : <><EyeOff size={12} /> скрыта</>}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <button className="ds-btn ds-btn-secondary text-sm flex items-center gap-1.5" onClick={() => setOpen(true)} disabled={vehicleList.length === 0}>
          <Plus size={14} /> {vehicleList.length === 0 ? 'Сначала добавьте машину' : 'Завести поездку'}
        </button>
      ) : (
        <form className="ds-card p-4 grid grid-cols-2 gap-3" onSubmit={e => { e.preventDefault(); void submit(); }}>
          <label className="text-xs text-[var(--text-secondary)] col-span-2">Машина
            <select className="ds-input mt-1 w-full" value={vehicleId} onChange={e => { setVehicleId(e.target.value); const v = vehicleList.find(x => x.id === e.target.value); if (v) setSeatsTotal(v.seats); }} required>
              <option value="">— выбрать —</option>
              {vehicleList.map(v => <option key={v.id} value={v.id}>{v.title} · {v.seats} мест</option>)}
            </select>
          </label>
          <label className="text-xs text-[var(--text-secondary)]">Дата
            <input type="date" className="ds-input mt-1 w-full" value={date} onChange={e => setDate(e.target.value)} required />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">Когда выезд (словами)
            <input className="ds-input mt-1 w-full" value={note} onChange={e => setNote(e.target.value)} maxLength={100} placeholder="рано утром, к шести" />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">Откуда
            <input className="ds-input mt-1 w-full" value={fromText} onChange={e => setFromText(e.target.value)} required minLength={2} maxLength={200} />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">Куда
            <input className="ds-input mt-1 w-full" value={toText} onChange={e => setToText(e.target.value)} required minLength={2} maxLength={200} placeholder="Вулкан Горелый" />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">Мест в поездке
            <input type="number" min={1} max={60} className="ds-input mt-1 w-full" value={seatsTotal} onChange={e => setSeatsTotal(Number(e.target.value) || 1)} />
          </label>
          <label className="text-xs text-[var(--text-secondary)]">Цена места, ₽ (пусто — не продаётся поштучно)
            <input type="number" min={1} className="ds-input mt-1 w-full" value={price} onChange={e => setPrice(e.target.value)} />
          </label>
          <label className="text-xs text-[var(--text-secondary)] col-span-2 flex items-center gap-2">
            <input type="checkbox" checked={publish} onChange={e => setPublish(e.target.checked)} /> Сразу выставить остаток мест в витрину
          </label>
          <div className="col-span-2 flex gap-2">
            <button type="submit" className="ds-btn ds-btn-primary text-sm" disabled={busy}>{busy ? 'Сохраняем…' : 'Создать поездку'}</button>
            <button type="button" className="ds-btn ds-btn-secondary text-sm" onClick={() => setOpen(false)}>Отмена</button>
          </div>
        </form>
      )}
    </section>
  );
}

// ── Запросы мест ────────────────────────────────────────────────────────────

function Requests({ requests, onChanged, say }: { requests: Load<SeatRequest>; onChanged: () => void; say: (k: 'ok' | 'err', t: string) => void }) {
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const decide = async (r: SeatRequest, action: 'confirm' | 'decline') => {
    setBusyId(r.id);
    try {
      const body = action === 'confirm'
        ? { action, price: prices[r.id] ? Number(prices[r.id]) : null }
        : { action, reason: reasons[r.id] ?? '' };
      const res = await readJson(await fetch(`/api/hub/carrier/requests/${r.id}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
      if (!res.ok) { say('err', res.error ?? 'Не удалось'); return; }
      say('ok', action === 'confirm' ? 'Места подтверждены — заказчик увидит цену и сможет оплатить по QR' : 'Запрос отклонён');
      onChanged();
    } finally { setBusyId(null); }
  };

  return (
    <section>
      {requests.state === 'loading' && <p className="text-sm text-[var(--text-muted)]">Читаем запросы…</p>}
      {requests.state === 'failed' && <Failed what="запросы" message={requests.message} />}
      {requests.state === 'ok' && requests.items.length === 0 && (
        <p className="text-sm text-[var(--text-secondary)]">Новых запросов нет. Запросы приходят с витрины, когда поездка выставлена.</p>
      )}
      {requests.state === 'ok' && requests.items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {requests.items.map(r => (
            <li key={r.id} className="ds-card p-4">
              <p className="text-sm font-semibold text-[var(--text-primary)]">{fmtDate(r.trip_date)} · {r.from_text} — {r.to_text}</p>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {r.vehicle_title} · мест: {r.seats} · {r.ordered_by_partner_name ? `туроператор ${r.ordered_by_partner_name}` : 'турист'}
                {r.contact_phone ? ` · ${r.contact_phone}` : ''}
              </p>
              {r.comment && <p className="text-xs text-[var(--text-secondary)] mt-1">«{r.comment}»</p>}
              <div className="grid grid-cols-2 gap-2 mt-3">
                <label className="text-xs text-[var(--text-secondary)]">Цена заказа, ₽ (пусто — по цене места)
                  <input type="number" min={1} className="ds-input mt-1 w-full" value={prices[r.id] ?? ''} onChange={e => setPrices({ ...prices, [r.id]: e.target.value })} />
                </label>
                <label className="text-xs text-[var(--text-secondary)]">Причина отказа
                  <input className="ds-input mt-1 w-full" value={reasons[r.id] ?? ''} onChange={e => setReasons({ ...reasons, [r.id]: e.target.value })} maxLength={300} placeholder="если отказываете" />
                </label>
                <button className="ds-btn ds-btn-primary text-sm flex items-center justify-center gap-1" disabled={busyId === r.id} onClick={() => void decide(r, 'confirm')}><Check size={14} /> Подтвердить</button>
                <button className="ds-btn ds-btn-secondary text-sm flex items-center justify-center gap-1" disabled={busyId === r.id || !(reasons[r.id] ?? '').trim()} onClick={() => void decide(r, 'decline')}><X size={14} /> Отклонить</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
