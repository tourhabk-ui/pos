'use client';

/**
 * MobileModeSwitcher — переключатель «Режима похода» над bento-сеткой.
 * Текстовые пилюли без иконок: у lucide нет буквальной иконки «вертолёт»,
 * а натягивать Plane на «Вертолётные туры» было бы визуально нечестно —
 * иконки можно добавить отдельным полишем позже, когда появится точный
 * набор.
 */

import { useAdventureMode, type AdventureMode } from '@/contexts/AdventureModeContext';

const MODES: { value: AdventureMode; label: string }[] = [
  { value: 'all',        label: 'Все' },
  { value: 'trekking',   label: 'Треккинг' },
  { value: 'bears',      label: 'Медведи' },
  { value: 'thermal',    label: 'Термальные источники' },
  { value: 'boat_trip',  label: 'Морские туры' },
  { value: 'helicopter', label: 'Вертолётные туры' },
];

export function MobileModeSwitcher() {
  const { mode, setMode } = useAdventureMode();
  return (
    <div role="tablist" aria-label="Режим похода" className="flex gap-2 overflow-x-auto px-4 pb-1 pt-3">
      {MODES.map(m => {
        const active = mode === m.value;
        return (
          <button
            key={m.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setMode(m.value)}
            className={
              active
                ? 'shrink-0 rounded-full border border-[var(--accent)] bg-[var(--accent)]/10 px-4 py-2 text-sm font-medium text-[var(--accent)] transition-all duration-200 active:scale-95'
                : 'shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-all duration-200 active:scale-95'
            }
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
