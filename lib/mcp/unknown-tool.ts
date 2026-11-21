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

/**
 * Живое имя под чужим написанием (21.11, панель владельца: 18 запросов
 * «не-идентификатор» за один день 20.11). Клиенты и каталоги пишут имя
 * инструмента по-своему: с именем сервера впереди (`vedar:get_tours`,
 * `vedar-kamchatka/get_tours`, `mcp__vedar__get_tours`, `functions.get_tours`),
 * через дефис или пробел (`get-tours`, `Get tours`), верблюдом (`getTours`).
 * Всё это — тот же инструмент, и отказ «нет такого» здесь только тратит
 * агенту ход.
 *
 * Правило узкое: после нормализации имя должно совпасть с живым ЦЕЛИКОМ.
 * Ближайшее по написанию (nearestToolName) сюда не идёт — его агент получает
 * подсказкой в отказе, а не исполнением: `get_tour` и `get_tours` — разные
 * намерения. Пробы (`no_such_tool`, `*_probe`) ни с чем не совпадают и
 * остаются отказом. Проверки пишущих инструментов (согласие, телефон) алиас
 * не обходит: исполняется тот же инструмент с тем же входом.
 */
export function resolveToolAlias(requested: string, names: ReadonlySet<string> = PUBLIC_MCP_TOOL_NAMES): string | null {
  if (names.has(requested)) return requested;
  const raw = requested.trim();
  if (raw === '' || raw.length > 80) return null;
  const norm = (x: string): string => x
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const whole = norm(raw);
  if (names.has(whole)) return whole;
  // Префикс сервера: берётся хвост после последнего разделителя `:` `/` `.` `__`.
  const tail = raw.split(/[:/.]|__/).filter(Boolean).pop() ?? '';
  const t = norm(tail);
  return t && names.has(t) ? t : null;
}

/** Похоже на фразу, а не на имя: агент прислал слова вместо имени инструмента. */
const looksLikePhrase = (s: string): boolean => /\s/.test(s.trim());

export function unknownToolResponse(requested: string): { message: string; data: { available: string[]; suggestion: string | null } } {
  const available = [...PUBLIC_MCP_TOOL_NAMES].sort();
  const suggestion = nearestToolName(requested, available);
  const shown = requested.slice(0, 80);
  // Пустое имя — не «неизвестный инструмент», а вызов без имени: агенту надо
  // сказать, куда имя класть, иначе он повторит тот же пустой вызов.
  const head = requested.trim() === ''
    ? 'Tool name is missing: tools/call needs params.name (A2A: DataPart "tool") set to one of the tool names below, and the inputs in arguments.'
    : `Unknown tool: ${shown}.` + (suggestion ? ` Did you mean: ${suggestion}?` : '');
  const phrase = looksLikePhrase(requested)
    ? ' The tool name must be an exact name from tools/list, not a phrase; a question in words goes to A2A as a TextPart.'
    : '';
  const message = `${head}${phrase} Available tools: ${available.join(', ')}.`;
  return { message, data: { available, suggestion } };
}
