'use client';

/**
 * «Безопасность и разрешения» — один свёрнутый блок под планом (слово
 * владельца 21.11). Сводки МЧС и Турпортала, разрешения, медведи, связь,
 * путёвки, совет по одежде — каждая строка один раз, с днями, к которым
 * относилась. Свёрнут по умолчанию; критичное видно числом в заголовке.
 */
import { ShieldAlert } from 'lucide-react';
import { SAFETY_BLOCK_TITLE, safetyItemText, type SafetyItem } from '@/lib/planner/day-card-view';

function pointsWord(n: number): string {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return 'пункт';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'пункта';
  return 'пунктов';
}

export function SafetyBlock({ items }: { items: readonly SafetyItem[] }) {
  if (items.length === 0) return null;
  const critical = items.filter((i) => i.severity === 'critical').length;
  return (
    <details className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]" data-safety-block>
      <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer text-xs font-semibold text-[var(--text-primary)]">
        <ShieldAlert className="w-4 h-4 text-[var(--warning)] shrink-0" aria-hidden="true" />
        <span>{SAFETY_BLOCK_TITLE}</span>
        <span className="text-[10px] font-normal text-[var(--text-muted)]">
          {items.length} {pointsWord(items.length)}
          {critical > 0 && <span className="ml-1 text-[var(--danger)] font-semibold">· важно: {critical}</span>}
        </span>
      </summary>
      <ul className="px-3 pb-3 space-y-1.5">
        {items.map((it) => (
          <li key={it.text} className={`text-[11px] leading-snug ${it.severity === 'critical' ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'}`}>
            {safetyItemText(it)}
          </li>
        ))}
      </ul>
    </details>
  );
}
