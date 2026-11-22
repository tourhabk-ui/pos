'use client';
/**
 * «План Б» для дня, который решает погода (супер-планер, 22.11): вертолёт,
 * море, восхождение. Пометка «зависит от погоды», прогноз дня фактами, обмен
 * с другим днём той же зоны в пределах прогноза и готовая замена из каталога —
 * тур той же зоны на эту дату, который лётная и морская погода не отменяет
 * (lib/planner/weather-plan-b, lib/planner/day-options). Решение о выезде —
 * за оператором; заявка — не бронь.
 */
import { useState } from 'react';
import { CloudFog, ChevronDown, ChevronUp, ArrowUpDown, Loader2 } from 'lucide-react';
import { optionFacts, type CompareDay, type DayOption } from '@/lib/planner/day-options';
import {
  forecastFacts, swapPlan, weatherDayKind, WEATHER_KIND_SHORT,
  type Comparison, type PlanBDay,
} from '@/lib/planner/weather-plan-b';
import { loadDayOptions, OptionCard, NOT_A_BOOKING, type OptionsLoad } from './DayCompare';

const VERDICT: Record<Comparison, string> = {
  better: 'по прогнозу там погода лучше',
  worse: 'по прогнозу там погода хуже',
  mixed: 'по прогнозу там в чём-то лучше, в чём-то хуже',
  same: 'по прогнозу там примерно так же',
};

export function DayPlanB<T extends CompareDay & PlanBDay>({ day, days, people, date, dateOf, onPut, onSwap }: {
  day: T;
  days: readonly T[];
  people: number;
  date: string;
  /** Дата дня по его номеру — подпись «чт, 3 дек». */
  dateOf: (dayNum: number) => string;
  onPut: (day: number, option: DayOption) => void;
  onSwap: (a: number, b: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<OptionsLoad>({ state: 'idle' });
  const kind = weatherDayKind(day);
  if (!kind) return null;

  const fetchGround = () => {
    if (!date) { setLoad({ state: 'error', message: 'Дат поездки нет — замену на дату не подобрать' }); return; }
    setLoad({ state: 'loading' });
    const params: Record<string, string> = {
      mode: 'ground', zone: day.zone, date, participants: String(people), limit: '2',
    };
    if (day.realTour?.tourId) params.exclude = day.realTour.tourId;
    void loadDayOptions(params).then(setLoad);
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && (load.state === 'idle' || load.state === 'error')) fetchGround();
  };
  const swap = swapPlan(days, day.day);

  return (
    <div className="mx-3 mb-2.5" data-day-plan-b>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 min-h-8 px-2.5 rounded-md bg-[var(--ocean)]/10 text-[var(--ocean)] text-xs font-semibold text-left"
      >
        <CloudFog className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="flex-1">Зависит от погоды · План Б</span>
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] p-2.5 space-y-3" data-plan-b-panel>
          <div className="text-xs leading-snug text-[var(--text-secondary)] space-y-1">
            <p>Почему: {WEATHER_KIND_SHORT[kind]}. Выйдет ли группа, решает оператор в день выезда.</p>
            <p data-plan-b-forecast>
              {day.weatherForecast
                ? <>Прогноз на этот день: <span className="text-[var(--text-primary)] font-medium">{forecastFacts(day.weatherForecast)}</span>.</>
                : 'Прогноза на эту дату ещё нет.'}
            </p>
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">Поменять дни местами</p>
            {swap.refusal
              ? <p className="text-xs text-[var(--text-secondary)]">{swap.refusal}.</p>
              : (
                <ul className="space-y-1.5">
                  {swap.options.map((o) => (
                    <li key={o.day} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 flex flex-col sm:flex-row sm:items-center gap-2" data-swap-option>
                      <div className="flex-1 min-w-0 text-xs leading-snug">
                        <p className="font-semibold text-[var(--text-primary)]">День {o.day}{dateOf(o.day) ? `, ${dateOf(o.day)}` : ''} — {o.title}</p>
                        <p className="text-[var(--text-secondary)]">Прогноз: {o.facts}; {VERDICT[o.comparison]}.</p>
                        {o.note && <p className="text-[var(--warning)]">{o.note}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => onSwap(day.day, o.day)}
                        className="inline-flex items-center justify-center gap-1 min-h-9 px-3 rounded-md border border-[var(--accent)] text-[var(--accent)] text-xs font-semibold hover:bg-[var(--accent)]/10 shrink-0"
                      >
                        <ArrowUpDown className="w-3.5 h-3.5" />Поменять местами
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">Если не состоится — замена из каталога</p>
            {load.state === 'loading' && (
              <p className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"><Loader2 className="w-3.5 h-3.5 animate-spin" />Ищем туры этой зоны на дату, которые погода не отменяет…</p>
            )}
            {load.state === 'error' && (
              <p className="text-xs text-[var(--warning)]" role="status">
                {load.message}{' '}
                {date && <button type="button" className="underline font-semibold" onClick={fetchGround}>Повторить</button>}
              </p>
            )}
            {load.state === 'done' && load.options.length === 0 && (
              <p className="text-xs text-[var(--text-secondary)]">В этой зоне на эту дату туров без вертолёта и моря в каталоге нет — остаётся резервный день или обмен дней.</p>
            )}
            {load.state === 'done' && load.options.length > 0 && (
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                {load.options.map((o) => (
                  <OptionCard
                    key={o.id}
                    option={o}
                    facts={optionFacts(o, day, people)}
                    action="Поставить вместо"
                    onAction={() => { onPut(day.day, o); setOpen(false); setLoad({ state: 'idle' }); }}
                  />
                ))}
              </div>
            )}
            {load.state === 'done' && (
              <p className="mt-2 text-[10.5px] leading-snug text-[var(--text-muted)]">{load.orderNote ? `${load.orderNote} ` : ''}{NOT_A_BOOKING}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
