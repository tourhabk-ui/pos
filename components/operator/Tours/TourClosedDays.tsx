'use client';

/**
 * Закрыть день тура в кабинете (#3476 шаг 4). У тура «в любой день сезона»
 * календарь — исключения: закрытый день не предлагается туристу, запрос мест
 * на него получает отказ до оператора, бронь его не пропускает
 * (lib/tours/closed-days, DATE_BLOCKED в брони).
 *
 * Пишет тот же роут, что календарь (`/api/operator/calendar/block`, POST —
 * закрыть, DELETE — открыть): одно выражение и проверка владения туром в нём.
 * До этого дня кнопки у роута на сайте не было — закрыть день можно было
 * только в чате.
 *
 * `closed` — из ответа расписания (`closed_days`); null — не прочитались, и
 * это сказано, а не показано пустым списком.
 */

import { useState } from 'react';
import { Loader2, Ban } from 'lucide-react';
import { formatDateOnly } from '@/lib/dates/date-only';

const inp = 'w-full px-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';
const lbl = 'block text-xs font-medium text-[var(--text-muted)] mb-1';

export default function TourClosedDays({ tourId, closed, onChanged, onError }: {
  tourId: string;
  closed: readonly string[] | null;
  /** Закрыто или открыто — перечитать расписание. */
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [day, setDay] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function send(method: 'POST' | 'DELETE', date: string) {
    setBusy(date);
    try {
      const res = await fetch('/api/operator/calendar/block', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tourId: Number(tourId), startDate: date, endDate: date }),
      });
      const json = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Ошибка');
      if (method === 'POST') setDay('');
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : (method === 'POST' ? 'Не удалось закрыть день' : 'Не удалось открыть день'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label className={lbl} htmlFor="tour-day-close">Закрыть день</label>
          <input
            id="tour-day-close"
            type="date"
            className={inp}
            value={day}
            min={new Date().toISOString().slice(0, 10)}
            onChange={e => setDay(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => send('POST', day)}
          disabled={!day || busy !== null}
          className="flex items-center gap-1.5 px-4 py-2 text-sm border border-[var(--border)] rounded-lg text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          {busy === day && day ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
          Закрыть
        </button>
      </div>
      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        В закрытый день туристы не оставят заявку. Уже принятые брони это не отменяет.
      </p>
      {closed === null ? (
        <p role="status" className="text-xs" style={{ color: 'var(--warning)' }}>
          Закрытые дни не загрузились — обновите расписание.
        </p>
      ) : closed.length > 0 && (
        <ul aria-label="Закрытые дни" className="flex flex-wrap gap-2">
          {closed.map((d) => (
            <li key={d} className="flex items-center gap-2 px-2.5 py-1 rounded-lg border border-[var(--border)] text-xs text-[var(--text-primary)]">
              <span>Закрыт: {formatDateOnly(d, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              <button
                type="button"
                onClick={() => send('DELETE', d)}
                disabled={busy !== null}
                className="text-[var(--ocean)] hover:underline disabled:opacity-40"
              >
                {busy === d ? 'Открываю…' : 'Открыть'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
