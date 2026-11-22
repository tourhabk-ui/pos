/**
 * Заголовок Server-Timing замера этапов планера (фича 7, 23.11).
 * Сторож: tests/unit/planner-server-timing.test.ts.
 */
/** `alerts;dur=120, zones;dur=40, …, total;dur=900` — только имена этапов и числа. */
export function serverTiming(stages: ReadonlyArray<readonly [string, number]>, totalMs: number): string {
  return [...stages, ['total', totalMs] as const]
    .filter(([n]) => /^[a-z_]+$/.test(n))
    .map(([n, ms]) => `${n};dur=${Math.max(0, Math.round(ms))}`)
    .join(', ');
}
