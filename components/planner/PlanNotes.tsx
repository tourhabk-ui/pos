'use client';

/**
 * «О плане: что не вошло и почему» — один свёрнутый блок ПОД днями (кейс
 * владельца с /planner 24.11–04.12, 22.11: «предупреждения — кроме них ничего
 * не видно»). До правки каждая заметка о самом плане (сезон, зоны, туры без
 * выездов, «не поместились») была отдельной цветной плашкой НАД днями, и
 * дней на первом экране не было. Критичное («план не собрался») по-прежнему
 * стоит сверху — его рисует страница, а не этот блок.
 */
import { Info } from 'lucide-react';
import type { PlanWarningLike } from '@/lib/planner/day-card-view';

export const PLAN_NOTES_TITLE = 'О плане: что не вошло и почему';

export function PlanNotes({ notes }: { notes: readonly PlanWarningLike[] }) {
  if (notes.length === 0) return null;
  return (
    <details className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]" data-plan-notes>
      <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer text-xs font-semibold text-[var(--text-primary)]">
        <Info className="w-4 h-4 text-[var(--ocean)] shrink-0" aria-hidden="true" />
        <span>{PLAN_NOTES_TITLE}</span>
        <span className="text-[10px] font-normal text-[var(--text-muted)]">{notes.length}</span>
      </summary>
      <ul className="px-3 pb-3 space-y-1.5">
        {notes.map((w) => (
          <li key={w.message} className="text-[11px] leading-snug text-[var(--text-secondary)]">{w.message}</li>
        ))}
      </ul>
    </details>
  );
}
