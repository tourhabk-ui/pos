'use client';
/**
 * «Сравнить и заменить» день плана (супер-планер, 22.11): другие туры того же
 * вида на дату дня рядом с текущим, у каждого — «за» и «против» словами
 * (lib/planner/day-options). «Поставить» кладёт тур в день; цену и места на
 * дату экран перечитывает, смета пересчитывается. Заявка — не бронь.
 */
import { useState } from 'react';
import { ArrowLeftRight, Check, AlertTriangle, Info, Loader2, X } from 'lucide-react';
import {
  compareRefusal, currentFacts, optionFacts, parseDayOptions,
  type CompareDay, type DayOption, type OptionFact,
} from '@/lib/planner/day-options';

export type OptionsLoad =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'done'; options: DayOption[]; orderNote: string | null };

export const NOT_A_BOOKING = 'Заявка — не бронь: места, дату и цену подтверждает оператор.';

/** Варианты дня с сервера; отказ — свой исход, не «вариантов нет». */
export async function loadDayOptions(params: Record<string, string>): Promise<OptionsLoad> {
  try {
    const res = await fetch(`/api/planner/day-options?${new URLSearchParams(params).toString()}`);
    const body: unknown = await res.json().catch(() => null);
    const parsed = res.ok ? parseDayOptions(body) : null;
    if (!parsed) {
      const msg = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error : 'Варианты не загрузились, попробуйте позже';
      return { state: 'error', message: msg };
    }
    return { state: 'done', ...parsed };
  } catch (err) {
    console.error('[planner] варианты дня не загрузились:', err instanceof Error ? err.message : String(err));
    return { state: 'error', message: 'Варианты не загрузились — проверьте связь и попробуйте ещё раз' };
  }
}

export function FactList({ facts }: { facts: readonly OptionFact[] }) {
  return (
    <ul className="space-y-1" data-option-facts>
      {facts.map((f, i) => (
        <li key={i} className="flex items-start gap-1.5 text-[11.5px] leading-snug" data-tone={f.tone}>
          {f.tone === 'pro'
            ? <Check className="w-3 h-3 mt-0.5 shrink-0 text-[var(--success)]" aria-label="за" />
            : f.tone === 'con'
            ? <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-[var(--warning)]" aria-label="против" />
            : <Info className="w-3 h-3 mt-0.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />}
          <span className={f.tone === 'info' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function OptionCard({ option, facts, action, onAction }: {
  option: Pick<DayOption, 'title'>;
  facts: readonly OptionFact[];
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-2.5 flex flex-col gap-2" data-day-option>
      <p className="text-[13px] font-semibold leading-snug text-[var(--text-primary)] line-clamp-2">{option.title}</p>
      <FactList facts={facts} />
      <button
        type="button"
        onClick={onAction}
        className="mt-auto min-h-9 rounded-md bg-[var(--accent)] text-white text-xs font-semibold px-3 hover:opacity-90"
      >
        {action}
      </button>
    </div>
  );
}

export function DayCompare<T extends CompareDay>({ day, days, people, date, onPut }: {
  day: T;
  days: readonly T[];
  people: number;
  /** Дата дня 'YYYY-MM-DD'; нет дат поездки — сравнения нет. */
  date: string;
  onPut: (day: number, option: DayOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<OptionsLoad>({ state: 'idle' });
  if (!date || compareRefusal(days, day)) return null;

  const fetchOptions = () => {
    setLoad({ state: 'loading' });
    const params: Record<string, string> = {
      mode: 'same', activity_type: day.activityType, zone: day.zone, date,
      participants: String(people), limit: '3',
    };
    if (day.realTour?.tourId) params.exclude = day.realTour.tourId;
    void loadDayOptions(params).then(setLoad);
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && (load.state === 'idle' || load.state === 'error')) fetchOptions();
  };

  return (
    <div className="mx-3 mb-2.5" data-day-compare>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 min-h-8 px-2.5 rounded-md border border-[var(--accent)]/40 text-[var(--accent)] text-xs font-semibold hover:bg-[var(--accent)]/10"
      >
        {open ? <X className="w-3.5 h-3.5" /> : <ArrowLeftRight className="w-3.5 h-3.5" />}
        {open ? 'Скрыть варианты' : 'Сравнить и заменить'}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] p-2.5" data-compare-panel>
          <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2">Другие туры на этот день</p>
          {load.state === 'loading' && (
            <p className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"><Loader2 className="w-3.5 h-3.5 animate-spin" />Проверяем туры, места и цены на дату…</p>
          )}
          {load.state === 'error' && (
            <p className="text-xs text-[var(--warning)]" role="status">
              {load.message}{' '}
              <button type="button" className="underline font-semibold" onClick={fetchOptions}>Повторить</button>
            </p>
          )}
          {load.state === 'done' && (
            <>
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                <div className="rounded-lg border-2 border-[var(--accent)]/40 bg-[var(--bg-card)] p-2.5 flex flex-col gap-2" data-day-option-current>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent)]">Сейчас в плане</p>
                  <p className="text-[13px] font-semibold leading-snug text-[var(--text-primary)] line-clamp-2">{day.title}</p>
                  <FactList facts={currentFacts(day, people)} />
                </div>
                {load.options.map((o) => (
                  <OptionCard
                    key={o.id}
                    option={o}
                    facts={optionFacts(o, day, people)}
                    action="Поставить"
                    onAction={() => { onPut(day.day, o); setOpen(false); setLoad({ state: 'idle' }); }}
                  />
                ))}
              </div>
              {load.options.length === 0 && (
                <p className="mt-2 text-xs text-[var(--text-secondary)]">Других туров этого вида на эту дату в каталоге нет — в плане лучший из найденных.</p>
              )}
              <p className="mt-2 text-[10.5px] leading-snug text-[var(--text-muted)]">
                {load.orderNote ? `${load.orderNote} ` : ''}Только туры на один день. {NOT_A_BOOKING}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
