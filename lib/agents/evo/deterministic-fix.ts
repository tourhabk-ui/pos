/**
 * Детерминированные авто-фиксы Evolution Loop.
 *
 * «Рука действия» эволюции применяет ТОЛЬКО детерминированное — то, что
 * выводится из находки Growth Scan без участия модели и без хрупкого
 * git-apply AI-диффа (решение владельца: предохранитель = только
 * детерминированное).
 *
 * v1 — единственный вид: add_index. Он аддитивный (новая идемпотентная
 * миграция), а таблица/колонка берутся из ФИКСИРОВАННОГО множества, которое
 * детектит perf-скан (growth-agent.scanPerformance). Это позволяет раннеру
 * писать файл из значений allowlist'а, а не из сырых сетевых данных.
 *
 * delete_file (удаление мёртвого файла) СПЕЦИАЛЬНО НЕ автоприменяется: путь
 * пришёл бы из сетевого ответа, а удаление разрушительно и цель нельзя
 * ограничить безопасным allowlist'ом (CodeQL: network data → fs.rm). Мёртвые
 * модули остаются текстовым предложением человеку.
 *
 * Модель диффов НЕ пишет: loop эмитит структурированный payload, а раннер
 * (scripts/evo-apply.js) превращает его в файловую правку. SQL-шаблон
 * индекс-миграции живёт в раннере — там, где файлы реально создаются.
 */

// Совпадает с фиксированными множествами growth-agent.scanPerformance:
// именно эти таблицы/колонки он проверяет на отсутствие индекса. Держим
// allowlist каноничным здесь; раннер (JS) дублирует его как вторую линию.
export const INDEXABLE_TABLES = ['operator_bookings', 'agent_memory', 'ai_actions_log'] as const;
export const INDEXABLE_COLUMNS = ['created_at', 'booking_status', 'agent_id'] as const;

export interface DeterministicFix {
  kind: 'add_index';
  table: (typeof INDEXABLE_TABLES)[number];
  column: (typeof INDEXABLE_COLUMNS)[number];
}

// Заголовок находки perf-скана: «Нет индекса: operator_bookings.created_at».
const INDEX_TITLE = /^Нет индекса:\s*([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*$/i;

function pickTable(v: string): DeterministicFix['table'] | null {
  return INDEXABLE_TABLES.find((t) => t === v) ?? null;
}
function pickColumn(v: string): DeterministicFix['column'] | null {
  return INDEXABLE_COLUMNS.find((c) => c === v) ?? null;
}

/**
 * Возвращает детерминированную правку для находки — или null, если находка
 * не сводится к безопасному детерминированному действию из allowlist'а (тогда
 * loop оставит её текстовым предложением человеку).
 */
export function deterministicFix(issue: {
  category: string;
  title: string;
  file_path: string | null;
}): DeterministicFix | null {
  if (issue.category !== 'performance') return null;
  const m = INDEX_TITLE.exec(issue.title.trim());
  if (!m) return null;
  const table = pickTable(m[1].toLowerCase());
  const column = pickColumn(m[2].toLowerCase());
  if (!table || !column) return null;
  return { kind: 'add_index', table, column };
}

/**
 * Разбор payload из evo_evolution_log.diff_summary. Старые записи могли нести
 * сырой AI-дифф или delete_file (не JSON / не add_index) — такие возвращают
 * null и раннером игнорируются. Таблица/колонка сверяются с allowlist'ом.
 */
export function parseFixPayload(diffSummary: string | null): DeterministicFix | null {
  if (!diffSummary) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(diffSummary);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const f = obj as Record<string, unknown>;
  if (f.kind !== 'add_index' || typeof f.table !== 'string' || typeof f.column !== 'string') {
    return null;
  }
  const table = pickTable(f.table);
  const column = pickColumn(f.column);
  if (!table || !column) return null;
  return { kind: 'add_index', table, column };
}
