'use client';

/**
 * Добавить дату в карточке тура кабинета (раздел «Расписание»).
 *
 * Роут `POST /api/hub/operator/tours/[id]/availability` пишет дату и скрытому
 * туру (на межсезонье тур скрыт, даты сезона готовятся заранее) и говорит об
 * этом в ответе (`tour_hidden`, `message`); часть дат он может не открыть —
 * записано больше, чем мест в запросе (`refused`). До 22.10 карточка при
 * успехе ответ не читала и молча перерисовывала список: оператор считал дату
 * продающейся, хотя туристы её не видели (ревью 22.10). Теперь такой исход
 * назван строкой под формой.
 *
 * Отдельным компонентом, чтобы это судилось рендером (правило 13.10).
 */

import { useState } from 'react';
import { Loader2, Plus, AlertTriangle } from 'lucide-react';

const inp = 'w-full px-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';
const lbl = 'block text-xs font-medium text-[var(--text-muted)] mb-1';

interface AddAnswer {
  success?: boolean;
  error?: string;
  message?: string;
  tour_hidden?: boolean;
  refused?: Array<{ date: string; taken: number }>;
}

export default function TourDateAdd({ tourId, onAdded, onError }: {
  tourId: string;
  /** Дата записана — перечитать список дат. */
  onAdded: () => Promise<void> | void;
  /** Отказ — текст для общей строки ошибки карточки. */
  onError: (message: string) => void;
}) {
  const [newDate, setNewDate] = useState('');
  const [newSlots, setNewSlots] = useState('8');
  const [adding, setAdding] = useState(false);
  /** Записано, но не всё видно туристам или не всё открыто — словами. */
  const [note, setNote] = useState<string | null>(null);

  async function add() {
    if (!newDate || !newSlots) return;
    setAdding(true);
    setNote(null);
    try {
      const res = await fetch(`/api/hub/operator/tours/${tourId}/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dates: [{ date: newDate, available_slots: parseInt(newSlots, 10) }] }),
      });
      const json = await res.json().catch(() => ({})) as AddAnswer;
      if (!res.ok) throw new Error(json.error ?? 'Ошибка');
      if (json.tour_hidden || (json.refused?.length ?? 0) > 0) {
        setNote(json.message ?? (json.tour_hidden ? 'Тур скрыт — туристы эту дату пока не видят.' : null));
      }
      setNewDate('');
      setNewSlots('8');
      await onAdded();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Ошибка добавления даты');
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label className={lbl} htmlFor="tour-date-add-date">Дата</label>
          <input
            id="tour-date-add-date"
            type="date"
            className={inp}
            value={newDate}
            min={new Date().toISOString().slice(0, 10)}
            onChange={e => setNewDate(e.target.value)}
          />
        </div>
        <div className="w-28">
          <label className={lbl} htmlFor="tour-date-add-slots">Мест</label>
          <input
            id="tour-date-add-slots"
            type="number"
            min="1"
            max="500"
            className={inp}
            value={newSlots}
            onChange={e => setNewSlots(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={add}
          disabled={adding || !newDate || !newSlots}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-[var(--accent)] text-[var(--on-accent)] rounded-lg font-medium hover:bg-[var(--accent)]/90 transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Добавить
        </button>
      </div>
      {note && (
        <p role="status" className="flex items-start gap-2 px-3 py-2 rounded-lg border-l-4 text-xs"
          style={{ borderLeftColor: 'var(--warning)', color: 'var(--text-primary)' }}>
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} />
          <span>{note}</span>
        </p>
      )}
    </div>
  );
}
