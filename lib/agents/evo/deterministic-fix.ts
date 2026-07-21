/**
 * Детерминированные авто-фиксы Evolution Loop.
 *
 * «Рука действия» эволюции применяет ТОЛЬКО детерминированное — то, что
 * выводится из находки Growth Scan без участия модели и без хрупкого
 * git-apply AI-диффа (решение владельца: предохранитель = только
 * детерминированное). Отсюда:
 *   - add_index   — из находки «Нет индекса: <таблица>.<колонка>» (perf-скан
 *                   детектит отсутствие индекса детерминированным SQL);
 *   - delete_file — из подтверждённо-мёртвого модуля (dead_code).
 *
 * Модель диффов НЕ пишет: loop эмитит структурированный payload, а раннер
 * (GitHub Actions, scripts/evo-apply.js) превращает его в файловую правку.
 * SQL-шаблон индекс-миграции живёт в раннере — там, где файлы реально
 * создаются; здесь только определяется, ЧТО за правка и безопасна ли она.
 */

export interface DeterministicFix {
  kind: 'add_index' | 'delete_file';
  /** для add_index */
  table?: string;
  column?: string;
  /** для delete_file */
  path?: string;
}

// Пути, которые эволюция не трогает без человека ни при каких находках.
export const PROTECTED_PATHS = [
  'lib/auth/',
  'lib/payments/',
  'app/api/webhook/',
  'app/api/payments/',
  'app/api/safety/sos',
  'middleware.ts',
  '.env',
];

export function isProtectedPath(filePath: string | null): boolean {
  if (!filePath) return true; // без пути — не трогаем
  return PROTECTED_PATHS.some((p) => filePath.includes(p));
}

// Заголовок находки perf-скана: «Нет индекса: operator_bookings.created_at».
// Имена таблицы/колонки — только [a-z_0-9] (иначе не наш формат, не трогаем).
const INDEX_TITLE = /^Нет индекса:\s*([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*$/i;

/**
 * Возвращает детерминированную правку для находки — или null, если находка
 * не сводится к безопасному детерминированному действию (тогда loop оставит
 * её текстовым предложением человеку).
 */
export function deterministicFix(issue: {
  category: string;
  title: string;
  file_path: string | null;
}): DeterministicFix | null {
  if (issue.category === 'performance') {
    const m = INDEX_TITLE.exec(issue.title.trim());
    if (m) return { kind: 'add_index', table: m[1].toLowerCase(), column: m[2].toLowerCase() };
  }

  if (issue.category === 'dead_code' && issue.file_path && !isProtectedPath(issue.file_path)) {
    return { kind: 'delete_file', path: issue.file_path };
  }

  return null;
}

/**
 * Разбор payload из evo_evolution_log.diff_summary. Старые записи могли нести
 * сырой AI-дифф (не JSON) — такие возвращают null и раннером игнорируются.
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

  if (f.kind === 'add_index'
    && typeof f.table === 'string' && /^[a-z_][a-z0-9_]*$/i.test(f.table)
    && typeof f.column === 'string' && /^[a-z_][a-z0-9_]*$/i.test(f.column)) {
    return { kind: 'add_index', table: f.table.toLowerCase(), column: f.column.toLowerCase() };
  }

  if (f.kind === 'delete_file'
    && typeof f.path === 'string' && f.path.length > 0 && !isProtectedPath(f.path)) {
    return { kind: 'delete_file', path: f.path };
  }

  return null;
}
