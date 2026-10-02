/**
 * Ответ на несуществующий инструмент — списком живых имён (владелец 02.10:
 * «unknown — 21 из 21 в ошибке. Клиенты зовут старые названия и не узнают,
 * чем заменить»).
 *
 * До этого ответ был голым «Unknown tool: X». По спецификации MCP это
 * ошибка протокола, и агент должен перечитать tools/list — но на деле он
 * пересказывает человеку «инструмент не сработал». Теперь в тексте и в поле
 * data стоят все живые имена и ближайшее по написанию, если оно есть.
 */
import { PUBLIC_MCP_TOOL_NAMES } from '@/lib/mcp/public-tools';

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Ближайшее живое имя: подстрока в любую сторону (при нескольких — ближайшая
 * по длине: get_tour → get_tours, не get_tour_availability) или расстояние
 * не больше трети длины.
 */
export function nearestToolName(requested: string, names: Iterable<string> = PUBLIC_MCP_TOOL_NAMES): string | null {
  const r = requested.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!r) return null;
  let best: { name: string; d: number } | null = null;
  let sub: { name: string; gap: number } | null = null;
  for (const name of names) {
    const n = name.toLowerCase();
    if (n.includes(r) || r.includes(n)) {
      const gap = Math.abs(n.length - r.length);
      if (!sub || gap < sub.gap) sub = { name, gap };
      continue;
    }
    const d = levenshtein(r, n);
    if (d <= Math.max(2, Math.floor(Math.max(r.length, n.length) / 3)) && (!best || d < best.d)) best = { name, d };
  }
  return sub?.name ?? best?.name ?? null;
}

export function unknownToolResponse(requested: string): { message: string; data: { available: string[]; suggestion: string | null } } {
  const available = [...PUBLIC_MCP_TOOL_NAMES].sort();
  const suggestion = nearestToolName(requested, available);
  const shown = requested.slice(0, 80);
  const message = `Unknown tool: ${shown}.` +
    (suggestion ? ` Did you mean: ${suggestion}?` : '') +
    ` Available tools: ${available.join(', ')}.`;
  return { message, data: { available, suggestion } };
}
