/**
 * Анкета поправлена после сборки — план устарел (разбор планера 14.11,
 * экран-1). Правило — lib/planner/plan-stale.
 */
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { planStaleText } from '@/lib/planner/plan-stale';

export function PlanStaleNotice({ reasons, onRebuild, busy }: { reasons: readonly string[]; onRebuild: () => void; busy?: boolean }) {
  if (reasons.length === 0) return null;
  return (
    <div role="status" data-testid="plan-stale" className="flex flex-col gap-2 rounded-lg border border-[var(--warning)] bg-[var(--bg-card)] p-3">
      <p className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" />
        <span>{planStaleText(reasons)}</span>
      </p>
      <button type="button" onClick={onRebuild} disabled={busy} className="ds-btn ds-btn-primary self-start inline-flex items-center gap-2">
        <RefreshCw className="w-4 h-4" />
        {busy ? 'Собираю…' : 'Пересобрать план'}
      </button>
    </div>
  );
}
