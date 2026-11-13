'use client';

/**
 * Кольцо прогресса (12.11, «Офлайн: кольцо, сколько скачано»). Доля —
 * настоящая, из счётчика скачанных файлов; `null` — доля ещё не известна
 * (идёт подготовка), и кольцо стоит пустым, а не делает вид, что движется.
 * Дуга дорастает плавно, при «уменьшить движение» — сразу.
 */
export function ProgressRing({ percent, size = 20, label }: { percent: number | null; size?: number; label: string }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  const p = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent == null ? undefined : Math.round(p)}
      className="-rotate-90 shrink-0"
    >
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p / 100)}
        className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
        data-ring-arc
      />
    </svg>
  );
}
