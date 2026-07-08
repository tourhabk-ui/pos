'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Lock } from 'lucide-react';

/**
 * Тарифный календарь объекта размещения: месячная сетка, клик по дню —
 * цена на дату / блокировка продажи. Данные: GET/POST /api/stay/calendar.
 * Уровень тарифа выбирается селектором: весь объект (room_id IS NULL)
 * или конкретный номер — номерная цена приоритетнее при бронировании.
 * Занятость (брони) показывается числом в ячейке — только чтение.
 */

interface AccommodationOption {
  id: string;
  name: string;
}

interface RoomOption {
  id: string;
  name: string;
  pricePerNight: number;
}

interface RateRow {
  roomId: string | null;
  date: string;
  priceOverride: number | null;
  isBlocked: boolean;
  blockReason: string | null;
}

interface CalendarData {
  basePrice: number | null;
  totalRooms: number | null;
  rates: RateRow[];
  occupancy: { date: string; booked: number }[];
}

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatMoney(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(v);
}

export default function StayCalendarClient() {
  const [accommodations, setAccommodations] = useState<AccommodationOption[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  // '' — тарифы уровня объекта; иначе id номера
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [monthStart, setMonthStart] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [data, setData] = useState<CalendarData | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Редактор дня
  const [editDate, setEditDate] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState('');
  const [blockedInput, setBlockedInput] = useState(false);
  const [reasonInput, setReasonInput] = useState('');

  useEffect(() => {
    fetch('/api/stay/accommodations')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { accommodations: { id: string; name: string }[] } } | null) => {
        const list = d?.data?.accommodations ?? [];
        setAccommodations(list.map(a => ({ id: a.id, name: a.name })));
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch(() => setFailed(true));
  }, []);

  // Номера выбранного объекта — для селектора уровня тарифа
  useEffect(() => {
    if (!selectedId) return;
    setSelectedRoomId('');
    fetch(`/api/stay/accommodations/${selectedId}/rooms`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { rooms: { id: string; name: string; pricePerNight: number; isActive: boolean }[] } } | null) => {
        const list = d?.data?.rooms ?? [];
        setRooms(list.filter(r => r.isActive).map(r => ({ id: r.id, name: r.name, pricePerNight: r.pricePerNight })));
      })
      .catch(() => setRooms([]));
  }, [selectedId]);

  const rangeStart = ymd(monthStart);
  const rangeEnd = ymd(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0));

  const load = useCallback(() => {
    if (!selectedId) return;
    setData(null);
    fetch(`/api/stay/calendar?accommodationId=${selectedId}&startDate=${rangeStart}&endDate=${rangeEnd}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: CalendarData } | null) => {
        if (d?.success && d.data) setData(d.data);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [selectedId, rangeStart, rangeEnd]);

  useEffect(() => { load(); }, [load]);

  const rateByDate = useMemo(() => {
    const map = new Map<string, RateRow>();
    const level = selectedRoomId || null;
    for (const r of data?.rates ?? []) {
      if (r.roomId === level) map.set(r.date, r);
    }
    return map;
  }, [data, selectedRoomId]);

  const occupancyByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of data?.occupancy ?? []) map.set(o.date, o.booked);
    return map;
  }, [data]);

  // Ячейки месячной сетки: пустые до первого дня (Пн=0) + дни месяца
  const cells = useMemo(() => {
    const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const firstWeekday = (monthStart.getDay() + 6) % 7;
    const list: (string | null)[] = Array.from({ length: firstWeekday }, () => null);
    for (let day = 1; day <= daysInMonth; day++) {
      list.push(ymd(new Date(monthStart.getFullYear(), monthStart.getMonth(), day)));
    }
    return list;
  }, [monthStart]);

  function openEditor(date: string) {
    const rate = rateByDate.get(date);
    setEditDate(date);
    setPriceInput(rate?.priceOverride != null ? String(rate.priceOverride) : '');
    setBlockedInput(rate?.isBlocked ?? false);
    setReasonInput(rate?.blockReason ?? '');
  }

  // Массовое задание тарифа на диапазон (сезон/выходные)
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkStart, setBulkStart] = useState('');
  const [bulkEnd, setBulkEnd] = useState('');
  const [bulkPrice, setBulkPrice] = useState('');
  const [bulkBlocked, setBulkBlocked] = useState(false);
  // EXTRACT(DOW): 0=вс..6=сб; пустой набор — все дни
  const [bulkWeekdays, setBulkWeekdays] = useState<number[]>([]);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  const bulkValid =
    bulkStart !== '' && bulkEnd !== '' && bulkEnd >= bulkStart &&
    (bulkPrice !== '' || bulkBlocked);

  async function saveBulk() {
    if (!selectedId || !bulkValid) return;
    setBusy(true);
    setError(null);
    setBulkMessage(null);
    try {
      const res = await fetch('/api/stay/calendar/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accommodationId: selectedId,
          roomId: selectedRoomId || null,
          startDate: bulkStart,
          endDate: bulkEnd,
          ...(bulkWeekdays.length > 0 && bulkWeekdays.length < 7 ? { weekdays: bulkWeekdays } : {}),
          ...(bulkPrice !== '' ? { priceOverride: Number(bulkPrice) } : {}),
          isBlocked: bulkBlocked,
        }),
      });
      const d = await res.json() as { success?: boolean; error?: string; message?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось применить тариф к диапазону');
        return;
      }
      setBulkMessage(d.message ?? 'Применено');
      load();
    } catch {
      setError('Не удалось применить тариф к диапазону');
    } finally {
      setBusy(false);
    }
  }

  async function saveDay() {
    if (!editDate || !selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/stay/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accommodationId: selectedId,
          roomId: selectedRoomId || null,
          date: editDate,
          priceOverride: priceInput ? Number(priceInput) : null,
          isBlocked: blockedInput,
          blockReason: blockedInput && reasonInput.trim() ? reasonInput.trim() : null,
        }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось сохранить тариф');
        return;
      }
      setEditDate(null);
      load();
    } catch {
      setError('Не удалось сохранить тариф');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <CalendarDays className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Тарифный календарь</h1>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {failed && <p className="text-sm text-[var(--danger)]">Не удалось загрузить данные. Обновите страницу.</p>}

      {accommodations !== null && accommodations.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            У вас пока нет объектов размещения — календарь появится вместе с первым объектом.
          </p>
        </div>
      )}

      {accommodations !== null && accommodations.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <select
              className="ds-input max-w-xs"
              value={selectedId}
              aria-label="Объект размещения"
              onChange={e => setSelectedId(e.target.value)}>
              {accommodations.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>

            {rooms.length > 0 && (
              <select
                className="ds-input max-w-xs"
                value={selectedRoomId}
                aria-label="Уровень тарифа"
                onChange={e => setSelectedRoomId(e.target.value)}>
                <option value="">Весь объект</option>
                {rooms.map(r => <option key={r.id} value={r.id}>Номер: {r.name}</option>)}
              </select>
            )}

            <div className="flex items-center gap-1">
              <button
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                aria-label="Предыдущий месяц"
                onClick={() => setMonthStart(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1))}>
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm font-medium text-[var(--text-primary)] min-w-32 text-center">
                {MONTH_NAMES[monthStart.getMonth()]} {monthStart.getFullYear()}
              </span>
              <button
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                aria-label="Следующий месяц"
                onClick={() => setMonthStart(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1))}>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {(() => {
              const room = rooms.find(r => r.id === selectedRoomId);
              const base = room ? room.pricePerNight : data?.basePrice;
              return base != null ? (
                <span className="text-xs text-[var(--text-secondary)]">
                  Базовая цена{room ? ' номера' : ''}: {formatMoney(base)} ₽/ночь · клик по дню — своя цена или блокировка
                </span>
              ) : null;
            })()}
          </div>

          {/* Массовое задание: сезонные цены и блокировки диапазоном */}
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
            <button
              type="button"
              className="text-sm font-semibold text-[var(--text-primary)]"
              onClick={() => setBulkOpen(!bulkOpen)}
            >
              Задать на диапазон {bulkOpen ? '−' : '+'}
            </button>
            {bulkOpen && (
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
                <div>
                  <label className="ds-label">С даты</label>
                  <input className="ds-input" type="date" value={bulkStart}
                    onChange={e => setBulkStart(e.target.value)} />
                </div>
                <div>
                  <label className="ds-label">По дату</label>
                  <input className="ds-input" type="date" value={bulkEnd}
                    onChange={e => setBulkEnd(e.target.value)} />
                </div>
                <div>
                  <label className="ds-label">Цена, ₽/ночь</label>
                  <input className="ds-input" type="number" min="0" value={bulkPrice}
                    placeholder="Не менять" onChange={e => setBulkPrice(e.target.value)} />
                </div>
                <label className="flex items-center gap-2 text-sm text-[var(--text-primary)] pb-2.5">
                  <input type="checkbox" checked={bulkBlocked}
                    onChange={e => setBulkBlocked(e.target.checked)} />
                  Закрыть продажу
                </label>
                <div className="sm:col-span-2 lg:col-span-3">
                  <p className="ds-label mb-1.5">Дни недели (пусто — все)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {/* Порядок Пн..Вс; значения — EXTRACT(DOW): вс=0 */}
                    {[1, 2, 3, 4, 5, 6, 0].map((dow, i) => (
                      <button
                        key={dow}
                        type="button"
                        onClick={() => setBulkWeekdays(prev =>
                          prev.includes(dow) ? prev.filter(x => x !== dow) : [...prev, dow]
                        )}
                        className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                          bulkWeekdays.includes(dow)
                            ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--bg-hover)]'
                            : 'border-[var(--border)] text-[var(--text-secondary)]'
                        }`}
                      >
                        {WEEKDAYS[i]}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  className="ds-btn ds-btn-primary"
                  onClick={saveBulk}
                  disabled={!bulkValid || busy}
                >
                  {busy ? 'Применяем…' : 'Применить'}
                </button>
                {bulkMessage && (
                  <p className="text-xs text-[var(--success)] sm:col-span-2 lg:col-span-4">{bulkMessage}</p>
                )}
              </div>
            )}
          </div>

          {data === null && !failed && <div className="ds-skeleton h-80 rounded-lg" />}

          {data !== null && (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3 overflow-x-auto">
              <div className="grid grid-cols-7 gap-1 min-w-[560px]">
                {WEEKDAYS.map(w => (
                  <div key={w} className="text-center text-xs text-[var(--text-muted)] py-1">{w}</div>
                ))}
                {cells.map((date, i) => {
                  if (!date) return <div key={`empty-${i}`} />;
                  const rate = rateByDate.get(date);
                  const booked = occupancyByDate.get(date) ?? 0;
                  const day = Number(date.slice(8));
                  return (
                    <button
                      key={date}
                      onClick={() => openEditor(date)}
                      className={`min-h-16 rounded-lg border p-1.5 text-left align-top transition-colors
                        ${rate?.isBlocked
                          ? 'border-[var(--danger)] bg-[var(--bg-hover)]'
                          : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--accent)]'}`}
                      aria-label={`Настроить ${date}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-[var(--text-primary)]">{day}</span>
                        {rate?.isBlocked && <Lock className="w-3 h-3 text-[var(--danger)]" />}
                      </div>
                      {rate?.priceOverride != null && !rate.isBlocked && (
                        <p className="text-[11px] text-[var(--accent)] font-medium mt-0.5">
                          {formatMoney(rate.priceOverride)} ₽
                        </p>
                      )}
                      {booked > 0 && (
                        <p className="text-[11px] text-[var(--ocean)] mt-0.5">брони: {booked}</p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {editDate && (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 max-w-md space-y-3">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                {editDate.split('-').reverse().join('.')}
              </p>
              <div>
                <label className="ds-label">Цена на дату, ₽/ночь (пусто — базовая)</label>
                <input className="ds-input" type="number" min="0" value={priceInput}
                  onChange={e => setPriceInput(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <input type="checkbox" checked={blockedInput}
                  onChange={e => setBlockedInput(e.target.checked)} />
                Закрыть продажу на эту дату
              </label>
              {blockedInput && (
                <div>
                  <label className="ds-label">Причина (видна только вам)</label>
                  <input className="ds-input" value={reasonInput}
                    onChange={e => setReasonInput(e.target.value)} placeholder="Ремонт, свои гости…" />
                </div>
              )}
              <div className="flex gap-2">
                <button className="ds-btn ds-btn-primary" onClick={saveDay} disabled={busy}>
                  {busy ? 'Сохранение…' : 'Сохранить'}
                </button>
                <button className="ds-btn ds-btn-secondary" onClick={() => setEditDate(null)} disabled={busy}>
                  Отмена
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
