/**
 * План кончается в дальней зоне без дня на возвращение — после правки на
 * экране (разбор планера 14.11, экран-4). «Добавить в план» с местом в
 * Восточной зоне ставило день после «Возвращения», перед вылетом, и экран
 * молчал; чат и MCP эту же проверку делали (`planWideAfterEdit`). Правило
 * одно — lib/planner/plan-edit-warnings; строка движка не дублируется.
 */
import { AlertTriangle } from 'lucide-react';
import { planWideAfterEdit } from '@/lib/planner/plan-edit-warnings';
import type { ZoneId } from '@/lib/planner/constants';
import type { TripOrigin } from '@/lib/planner/trip-origin';

export function PlanReturnWarning({ days, origin, shown }: {
  days: ReadonlyArray<{ day: number; type: string; zone: ZoneId }>;
  origin: TripOrigin;
  /** Предупреждения, которые уже на экране (движка): та же строка второй раз не встаёт. */
  shown: readonly string[];
}) {
  const lines = planWideAfterEdit(days, origin).filter((m) => !shown.includes(m));
  if (lines.length === 0) return null;
  return (
    <div role="status" data-testid="plan-return-warning" className="space-y-1">
      {lines.map((m) => (
        <p key={m} className="flex items-start gap-2 rounded-lg border border-[var(--danger)] bg-[var(--bg-card)] p-3 text-sm text-[var(--text-primary)]">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--danger)]" />
          <span>{m}</span>
        </p>
      ))}
    </div>
  );
}
