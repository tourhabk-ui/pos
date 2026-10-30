'use client';

/**
 * Кабинет проката на сайте: то же, что кнопки «Мои машины», «Заявки» и
 * «Календарь» в MAX (владелец 26.10: прокатчику «Лагуны» — кабинет на сайте).
 *
 * Каждый список — три состояния: загружаем / есть / не смогли прочитать.
 * «Не смогли» не выдаётся за «нет» (§4.0). День календаря без отметки —
 * «не отмечено», а не «свободна». Ответ на заявку необратим, поэтому сначала
 * спрашивается подтверждение. Записи — только через /api/hub/carrier/rental/*.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CalendarDays, Car, Check, ClipboardList, Inbox, X } from 'lucide-react';

interface CabinetCar {
  offerId: string; title: string; pricePerDay: number; priceIsFrom: boolean; deposit: number | null; active: boolean;
}
interface CabinetRequest {
  leadId: string; name: string; phone: string; title: string | null;
  dateFrom: string | null; dateTo: string | null; answer: 'take' | 'decline' | null;
}
interface CabinetEdit {
  title: string; livePrice: number; priceIsFrom: boolean; draftPrice: number | null; draftConditions: string | null;
}
interface Cabinet {
  partnerName: string;
  canWrite: boolean;
  cars: CabinetCar[] | null;
  requests: CabinetRequest[] | null;
  olderRequests: boolean;
  edits: CabinetEdit[] | null;
}
interface CalendarDay { day: string; label: string; busy: boolean | null }

type Load = { state: 'loading' } | { state: 'ok'; data: Cabinet } | { state: 'failed'; message: string };

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

async function readJson<T>(res: Response): Promise<{ ok: boolean; data?: T; message?: string; error?: string }> {
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: T; message?: string; error?: string } | null;
  if (!res.ok || !body?.success) return { ok: false, error: body?.error ?? `Ошибка ${res.status}` };
  return { ok: true, data: body.data, message: body.message };
}

async function fetchCabinet(): Promise<Load> {
  try {
    const r = await readJson<Cabinet>(await fetch('/api/hub/carrier/rental', { credentials: 'include' }));
    return r.ok && r.data ? { state: 'ok', data: r.data } : { state: 'failed', message: r.error ?? 'не прочитали' };
  } catch {
    return { state: 'failed', message: 'нет связи с сервером' };
  }
}

type DaysLoad = { state: 'loading' } | { state: 'ok'; days: CalendarDay[] } | { state: 'failed'; message: string };

async function fetchDays(offerId: string): Promise<DaysLoad> {
  try {
    const r = await readJson<{ today: string; days: CalendarDay[] }>(
      await fetch(`/api/hub/carrier/rental/calendar?offer=${encodeURIComponent(offerId)}`, { credentials: 'include' }),
    );
    return r.ok && r.data ? { state: 'ok', days: r.data.days } : { state: 'failed', message: r.error ?? 'не прочитали' };
  } catch {
    return { state: 'failed', message: 'нет связи с сервером' };
  }
}

export default function RentalClient() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchCabinet().then((next) => { if (alive) setLoad(next); });
    return () => { alive = false; };
  }, []);

  const reload = useCallback(() => { void fetchCabinet().then(setLoad); }, []);

  const say = (kind: 'ok' | 'err', text: string) => setFlash({ kind, text });

  return (
    <div className="p-5 lg:p-6 max-w-3xl">
      <p className="ds-label mb-1">Перевозчик</p>
      <h1 className="ds-h1 mb-2">Прокат</h1>
      <p className="text-sm text-[var(--text-secondary)] mb-5">
        Машины без водителя из вашего прайса, заявки на прокат и календарь занятости. То же самое есть в MAX — кнопками бота.
      </p>

      {flash && (
        <p role={flash.kind === 'err' ? 'alert' : 'status'} className={`text-sm mb-4 ${flash.kind === 'ok' ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
          {flash.text}
        </p>
      )}

      {load.state === 'loading' && <div className="ds-skeleton h-24 rounded-lg" aria-label="Загружаем" />}
      {load.state === 'failed' && <Failed what="кабинет проката" message={load.message} />}
      {load.state === 'ok' && (
        <>
          {!load.data.canWrite && (
            <p className="ds-card p-4 text-sm text-[var(--text-secondary)] mb-6">
              Отвечать на заявки и отмечать календарь здесь можно участникам пилота проката. Ваша карточка в нём пока не участвует — списки ниже только для чтения.
            </p>
          )}
          <Cars cars={load.data.cars} canWrite={load.data.canWrite} say={say} />
          <Requests
            requests={load.data.requests}
            older={load.data.olderRequests}
            canWrite={load.data.canWrite}
            say={say}
            onAnswered={reload}
          />
          <Edits edits={load.data.edits} />
        </>
      )}
    </div>
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

// ── Машины и календарь ───────────────────────────────────────────────────────

function Cars({ cars, canWrite, say }: { cars: CabinetCar[] | null; canWrite: boolean; say: (k: 'ok' | 'err', t: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="mb-8">
      <h2 className="ds-h2 mb-3 flex items-center gap-2"><Car size={16} /> Мои машины</h2>
      {cars === null && <Failed what="машины" message="база не ответила" />}
      {cars !== null && cars.length === 0 && (
        <p className="text-sm text-[var(--text-secondary)]">В прайсе проката нет ни одной машины. Прайс заводит менеджер Ведара.</p>
      )}
      {cars !== null && cars.length > 0 && (
        <ul className="flex flex-col gap-3">
          {cars.map((c) => (
            <li key={c.offerId} className="ds-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-[var(--text-primary)]">{c.title}</p>
                <p className="text-sm text-[var(--text-primary)]">{c.priceIsFrom ? 'от ' : ''}{rub(c.pricePerDay)} за сутки</p>
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {c.active ? 'на сайте' : 'скрыта с сайта'} · {c.deposit !== null ? `залог ${rub(c.deposit)}` : 'залог не записан'}
              </p>
              <button
                type="button"
                className="ds-btn ds-btn-secondary text-xs px-2 py-1 mt-3 inline-flex items-center gap-1"
                aria-expanded={open === c.offerId}
                onClick={() => setOpen(open === c.offerId ? null : c.offerId)}
              >
                <CalendarDays size={14} /> {open === c.offerId ? 'Скрыть календарь' : 'Календарь'}
              </button>
              {open === c.offerId && <CarCalendar offerId={c.offerId} canWrite={canWrite} say={say} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function markWord(busy: boolean | null): string {
  if (busy === true) return 'занята';
  if (busy === false) return 'свободна';
  return 'не отмечено';
}

function markClass(busy: boolean | null): string {
  if (busy === true) return 'border-[var(--warning)] text-[var(--text-primary)]';
  if (busy === false) return 'border-[var(--success)] text-[var(--text-primary)]';
  return 'border-[var(--border)] text-[var(--text-muted)]';
}

function CarCalendar({ offerId, canWrite, say }: { offerId: string; canWrite: boolean; say: (k: 'ok' | 'err', t: string) => void }) {
  const [days, setDays] = useState<DaysLoad>({ state: 'loading' });
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchDays(offerId).then((next) => { if (alive) setDays(next); });
    return () => { alive = false; };
  }, [offerId]);

  const mark = async (busy: boolean) => {
    if (!picked) return;
    setSaving(true);
    try {
      const r = await readJson(await fetch('/api/hub/carrier/rental/calendar', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offerId, day: picked, busy }),
      }));
      if (!r.ok) { say('err', r.error ?? 'Отметка не записана'); return; }
      say('ok', `Отмечено: ${busy ? 'занята' : 'свободна'}.`);
      setPicked(null);
      setDays(await fetchDays(offerId));
    } catch {
      say('err', 'Нет связи с сервером. Отметка не записана.');
    } finally {
      setSaving(false);
    }
  };

  if (days.state === 'loading') return <div className="ds-skeleton h-16 rounded-lg mt-3" aria-label="Загружаем календарь" />;
  if (days.state === 'failed') return <div className="mt-3"><Failed what="календарь" message={days.message} /></div>;
  const pickedDay = days.days.find((d) => d.day === picked) ?? null;
  return (
    <div className="mt-3" data-testid={`calendar-${offerId}`}>
      <p className="text-xs text-[var(--text-secondary)] mb-2">Ближайшие 30 дней по Камчатке. «Не отмечено» — отметки нет, это не «свободна».</p>
      <ul className="grid grid-cols-3 sm:grid-cols-5 gap-2">
        {days.days.map((d) => (
          <li key={d.day}>
            <button
              type="button"
              disabled={!canWrite}
              aria-pressed={picked === d.day}
              onClick={() => setPicked(picked === d.day ? null : d.day)}
              className={`w-full min-h-[44px] rounded-lg border px-2 py-1 text-left text-xs transition-all duration-200 ${markClass(d.busy)} ${picked === d.day ? 'bg-[var(--bg-hover)]' : 'bg-[var(--bg-card)]'}`}
            >
              <span className="block font-semibold">{d.label}</span>
              <span className="block">{markWord(d.busy)}</span>
            </button>
          </li>
        ))}
      </ul>
      {canWrite && pickedDay && (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <span className="text-sm text-[var(--text-primary)]">{pickedDay.label}:</span>
          <button type="button" className="ds-btn ds-btn-secondary text-sm" disabled={saving} onClick={() => void mark(true)}>Занята</button>
          <button type="button" className="ds-btn ds-btn-secondary text-sm" disabled={saving} onClick={() => void mark(false)}>Свободна</button>
        </div>
      )}
    </div>
  );
}

// ── Заявки ───────────────────────────────────────────────────────────────────

function Requests({ requests, older, canWrite, say, onAnswered }: {
  requests: CabinetRequest[] | null;
  older: boolean;
  canWrite: boolean;
  say: (k: 'ok' | 'err', t: string) => void;
  onAnswered: () => void;
}) {
  const [confirm, setConfirm] = useState<{ leadId: string; answer: 'take' | 'decline' } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const send = async (leadId: string, answer: 'take' | 'decline') => {
    setBusyId(leadId);
    try {
      const r = await readJson(await fetch(`/api/hub/carrier/rental/requests/${leadId}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }),
      }));
      say(r.ok ? 'ok' : 'err', r.ok ? (r.message ?? 'Ответ записан.') : (r.error ?? 'Ответ не записан.'));
      setConfirm(null);
      onAnswered();
    } catch {
      say('err', 'Нет связи с сервером. Ответ не записан.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="mb-8">
      <h2 className="ds-h2 mb-1 flex items-center gap-2"><Inbox size={16} /> Заявки</h2>
      <p className="text-xs text-[var(--text-secondary)] mb-3">
        «Беру» отмечает дни машины занятыми и не закрепляет машину на сайте. «Не могу» дни не занимает. Ответ даётся один раз.
      </p>
      {requests === null && <Failed what="заявки" message="база не ответила" />}
      {requests !== null && requests.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Заявок на прокат пока нет.</p>}
      {requests !== null && requests.length > 0 && (
        <ul className="flex flex-col gap-3">
          {requests.map((r) => (
            <li key={r.leadId} className="ds-card p-4" data-testid={`request-${r.leadId}`}>
              <p className="text-sm font-semibold text-[var(--text-primary)]">{r.title ?? 'Машина в заявке не названа'}</p>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {r.dateFrom && r.dateTo ? `${r.dateFrom} — ${r.dateTo}` : 'даты не записаны'}
                {' · '}{r.name.trim() || 'имя не записано'}{' · '}{r.phone.trim() || 'телефон не записан'}
              </p>
              <p className="text-xs mt-1 text-[var(--text-secondary)]">
                {r.answer === 'take' ? 'Ваш ответ: беру' : r.answer === 'decline' ? 'Ваш ответ: не могу' : 'Ответа нет'}
              </p>
              {canWrite && r.answer === null && confirm?.leadId !== r.leadId && (
                <div className="flex flex-wrap gap-2 mt-3">
                  <button type="button" className="ds-btn ds-btn-primary text-sm inline-flex items-center gap-1" onClick={() => setConfirm({ leadId: r.leadId, answer: 'take' })}>
                    <Check size={14} /> Беру
                  </button>
                  <button type="button" className="ds-btn ds-btn-secondary text-sm inline-flex items-center gap-1" onClick={() => setConfirm({ leadId: r.leadId, answer: 'decline' })}>
                    <X size={14} /> Не могу
                  </button>
                </div>
              )}
              {canWrite && confirm?.leadId === r.leadId && (
                <div className="flex flex-wrap items-center gap-2 mt-3 p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]" role="group" aria-label="Подтверждение ответа">
                  <span className="text-sm text-[var(--text-primary)]">
                    {confirm.answer === 'take' ? 'Ответить «беру»? Дни заявки станут занятыми.' : 'Ответить «не могу»?'} Изменить ответ потом нельзя.
                  </span>
                  <button type="button" className="ds-btn ds-btn-primary text-sm" disabled={busyId === r.leadId} onClick={() => void send(r.leadId, confirm.answer)}>
                    Да, ответить
                  </button>
                  <button type="button" className="ds-btn ds-btn-secondary text-sm" disabled={busyId === r.leadId} onClick={() => setConfirm(null)}>
                    Отмена
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {older && <p className="text-xs text-[var(--text-secondary)] mt-3">Есть заявки старше этих. Их здесь нет — спросите менеджера Ведара.</p>}
    </section>
  );
}

// ── Правки на модерации ──────────────────────────────────────────────────────

function Edits({ edits }: { edits: CabinetEdit[] | null }) {
  return (
    <section>
      <h2 className="ds-h2 mb-1 flex items-center gap-2"><ClipboardList size={16} /> Правки прайса</h2>
      <p className="text-xs text-[var(--text-secondary)] mb-3">Правку цены или описания присылают в MAX командой бота. На сайте до одобрения — прежняя строка.</p>
      {edits === null && <Failed what="правки" message="база не ответила" />}
      {edits !== null && edits.length === 0 && <p className="text-sm text-[var(--text-secondary)]">Черновиков на модерации нет.</p>}
      {edits !== null && edits.length > 0 && (
        <ul className="flex flex-col gap-2">
          {edits.map((e, i) => (
            <li key={`${e.title}-${i}`} className="ds-card p-3 text-sm text-[var(--text-primary)]">
              <p className="font-semibold">{e.title}</p>
              {e.draftPrice !== null && (
                <p className="text-xs text-[var(--text-secondary)]">Черновик цены {rub(e.draftPrice)} за сутки, в прайсе сейчас {e.priceIsFrom ? 'от ' : ''}{rub(e.livePrice)}</p>
              )}
              {e.draftConditions !== null && <p className="text-xs text-[var(--text-secondary)]">Черновик описания: {e.draftConditions}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
