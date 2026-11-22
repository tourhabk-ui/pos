'use client';
/**
 * Полоса дней поверх карты плана (22.11, «карта — главный экран плана»).
 *
 * Номера дней на карте — пины, но пины одной точки сведены в один («1·10·11»),
 * а на телефоне пальцем в капсулу не попасть. Полоса — те же дни подряд:
 * номер, дата, начало названия; между днями со сменой зоны — сколько ехать
 * и на чём (zone-graph). Нажали день — карта едет к его пину, день открыт;
 * на телефоне под полосой — «Открыть в плане».
 */
import { useEffect, useRef } from 'react';
import { zoneLegs, type PlannerMapDay } from '@/lib/planner/map-markers';
import { planDayHex, zoneName } from '@/lib/planner/zone-style';
import type { DayPlaceCard } from '@/lib/planner/day-place-cards';

export interface StripDay extends PlannerMapDay {
  /** «вт, 24 ноя»; нет дат — пусто. */
  dateLabel?: string;
  /** Место/маршрут дня (day-place-cards): миниатюра и ссылка в строке открытого дня. */
  place?: DayPlaceCard | null;
}

export function PlannerDayStrip({ days, activeDay, onPick, onOpen }: {
  days: readonly StripDay[];
  activeDay: number | null;
  onPick: (day: number) => void;
  /** Открыть день в плане (телефон: вкладка «План»). */
  onOpen: (day: number) => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const show = () => {
      const el = activeRef.current;
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    };
    show();
    // Вкладку «Карта» открыли позже (телефон) — активный день прокрутить тогда.
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    let wasHidden = root.clientWidth === 0;
    const ro = new ResizeObserver(() => {
      const hidden = root.clientWidth === 0;
      if (wasHidden && !hidden) show();
      wasHidden = hidden;
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [activeDay]);
  if (days.length === 0) return null;
  const legs = new Map(zoneLegs(days).map(l => [l.toDay, l]));
  const activeIdx = activeDay === null ? -1 : days.findIndex(d => d.day === activeDay);
  const active = activeIdx >= 0 ? days[activeIdx] : null;
  return (
    <div ref={rootRef} data-day-strip className="pointer-events-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)]/95 backdrop-blur shadow-lg">
      {active && (
        <div className="flex items-center gap-2 px-3 pt-2 text-[12px]">
          {active.place?.photo && (
            // eslint-disable-next-line @next/next/no-img-element -- свой адрес /api/images, размер задан
            <img src={active.place.photo.src} alt={active.place.title} width={28} height={28} loading="lazy" decoding="async"
              title={`Фото: ${active.place.photo.author}`}
              className="shrink-0 rounded object-cover" style={{ width: 28, height: 28 }} />
          )}
          <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
            <b>День {activeIdx + 1}.</b> {active.title}
            <span className="text-[var(--text-secondary)]">
              {' · '}{active.dateLabel ? `${active.dateLabel} · ` : ''}{zoneName(active.zoneShown !== undefined ? active.zoneShown : active.zone)}
              {active.approx ? ' · место — по описанию тура' : ''}
            </span>
          </span>
          {active.place && (
            <a href={active.place.href} target="_blank" rel="noopener" data-strip-place
              className="hidden sm:inline shrink-0 text-[11px] font-medium text-[var(--accent)] hover:underline">
              {active.place.kind === 'route' ? 'Маршрут' : 'Место'} ↗
            </a>
          )}
          <button
            type="button"
            onClick={() => onOpen(active.day)}
            className="lg:hidden shrink-0 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-semibold text-white"
          >
            Открыть в плане
          </button>
        </div>
      )}
      <div className="flex items-stretch gap-1.5 overflow-x-auto overscroll-x-contain px-2 py-2 [scrollbar-width:thin]" role="list" aria-label="Дни плана на карте">
        {days.map((d, i) => {
          const leg = legs.get(d.day);
          const on = d.day === activeDay;
          return (
            <div key={d.day} role="listitem" className="flex items-center gap-1.5 shrink-0">
              {leg && (
                <span className="shrink-0 rounded-full border border-dashed border-[var(--border)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)] whitespace-nowrap" title={leg.title} data-leg>
                  {leg.note}
                </span>
              )}
              <button
                type="button"
                ref={on ? activeRef : undefined}
                onClick={() => onPick(d.day)}
                aria-pressed={on}
                title={d.title}
                className={`flex min-h-[44px] max-w-[168px] items-center gap-2 rounded-lg border px-2 py-1 text-left transition-colors ${
                  on
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                    : 'border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/60'
                }`}
              >
                <span
                  className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[12px] font-bold text-white ${on ? 'bg-[var(--accent)]' : ''}`}
                  // Цвет кружка — цвет пина дня на карте.
                  style={on ? undefined : { background: planDayHex() }}
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  {d.dateLabel && <span className="block text-[10px] leading-tight text-[var(--text-secondary)]">{d.dateLabel}</span>}
                  <span className="block truncate text-[12px] leading-tight text-[var(--text-primary)]">{d.title}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
