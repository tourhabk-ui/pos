/**
 * Причина ошибки и главный аргумент вызова MCP — для журнала (миграция 1143).
 *
 * Владелец 02.10: «12 падений get_place_info неразличимы — чинить нечего».
 * Журнал знал род ошибки, но не причину и не то, о чём спрашивали. Здесь
 * оба правила в одном месте:
 *
 *  - код причины — короткий машинный: у отказа по входу его называет сам
 *    McpUserError, у падения он выводится из исключения (SQLSTATE пула,
 *    таймаут, имя класса ошибки);
 *  - главный аргумент — ИМЯ всегда, ЗНАЧЕНИЕ только у читающих инструментов
 *    и только если оно не похоже на телефон или почту. У пишущих значение не
 *    пишется никогда: там имя и телефон человека (152-ФЗ).
 */

/** Какой аргумент считать главным — первый найденный из этого порядка. */
const PRIMARY_KEYS = [
  'name', 'place', 'volcano', 'tour', 'query', 'task', 'date', 'date_from',
  'when', 'interests', 'location', 'activity_type', 'days',
] as const;

export const ARG_VALUE_MAX = 40;
export const HIDDEN_VALUE = '[скрыто]';

const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Значение годится в журнал: не телефон (7+ цифр подряд с разделителями) и не почта. */
export function safeArgValue(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, '').length;
  if (digits >= 7 || s.includes('@')) return HIDDEN_VALUE;
  return s.slice(0, ARG_VALUE_MAX);
}

export interface PrimaryArg {
  key: string | null;
  value: string | null;
}

/**
 * Главный аргумент вызова. `isWrite` — инструмент пишет (заявка, бронь):
 * тогда только имя аргумента, значение — никогда.
 */
export function primaryArg(args: Record<string, unknown>, isWrite: boolean): PrimaryArg {
  const keys = Object.keys(args);
  if (keys.length === 0) return { key: null, value: null };
  const key = PRIMARY_KEYS.find(k => k in args && args[k] != null && args[k] !== '') ?? keys[0];
  const safeKey = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key) ? key : 'не-идентификатор';
  return { key: safeKey, value: isWrite ? null : safeArgValue(args[key]) };
}

/** Код исполнения: SQLSTATE пула, таймаут, иначе имя класса ошибки. */
export function classifyExecutionError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `pg:${code}`;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return `net:${code.slice(0, 36)}`;
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
    return `exc:${err.name.slice(0, 36) || 'Error'}`;
  }
  return 'exc:unknown';
}
