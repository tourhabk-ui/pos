'use client';

/**
 * «В поездке»: сегодня и завтра сверху плана (фича 4 супер-планера, 23.11).
 * Показывается только в дни поездки по камчатской дате. Данные — те, что
 * план уже несёт (lib/planner/day-brief): прогноз дня, что взять,
 * предупреждения дня, запасные туры на непогоду. Дата «сегодня» считается
 * после монтирования: сервер и браузер не спорят о сутках.
 */
import { useEffect, useState } from 'react';
import { CalendarClock, CloudSnow, AlertTriangle, Umbrella } from 'lucide-react';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { dayDateShort } from '@/lib/planner/plan-notes';
import { tripBrief, type BriefDayInput } from '@/lib/planner/day-brief';

export function TripToday({ days, arrival, zoneLabel }: {
  days: readonly BriefDayInput[];
  arrival: string | null | undefined;
  zoneLabel?: (zone: string) => string;
}) {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- дата клиента после монтирования, иначе гидрация спорит о сутках
    setToday(kamchatkaDate(new Date()));
  }, []);
  if (!today) return null;
  const brief = tripBrief(days, arrival, today);
  if (brief.state !== 'during' || brief.items.length === 0) return null;
  return (
    <section aria-label="В поездке" data-trip-today className="mb-3 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--accent)]">
        <CalendarClock className="w-3.5 h-3.5" />В поездке
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {brief.items.map((it) => (
          <div key={it.label} className="rounded-lg bg-[var(--bg-card)] border border-[var(--border)] p-2.5 text-xs">
            <p className="font-semibold text-[var(--text-primary)]">
              {it.label}, {dayDateShort(it.date)} · день {it.day.day}
            </p>
            <p className="mt-0.5 text-[var(--text-primary)]">{it.day.title}</p>
            {it.day.zone && zoneLabel && <p className="text-[var(--text-muted)]">{zoneLabel(it.day.zone)}</p>}
            {it.weatherLine
              ? <p className="mt-1 flex items-start gap-1 text-[var(--text-secondary)]"><CloudSnow className="w-3.5 h-3.5 mt-px shrink-0" />{it.weatherLine}</p>
              : <p className="mt-1 text-[var(--text-muted)]">Прогноза на этот день в плане нет.</p>}
            {it.advice && <p className="mt-0.5 text-[var(--text-secondary)]">{it.advice}</p>}
            {it.weatherRisk && (
              <p className="mt-1 flex items-start gap-1 text-[var(--warning)]"><Umbrella className="w-3.5 h-3.5 mt-px shrink-0" />Тур зависит от погоды, прогноз плохой — уточните у оператора с утра.</p>
            )}
            {it.day.planB && it.day.planB.length > 0 && it.day.weather?.bad && (
              <p className="mt-0.5 text-[var(--text-secondary)]">При непогоде: {it.day.planB.slice(0, 2).join('; ')}.</p>
            )}
            {(it.day.dayWarnings ?? []).slice(0, 3).map((w) => (
              <p key={w} className="mt-1 flex items-start gap-1 text-[var(--warning)]"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{w}</p>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
