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
 *    пишется никогда: там имя и телефон человека (152-ФЗ);
 *  - ключ заявки не пишется никогда (12.11, миграция 1428). Аргумент `key` у
 *    get_request_status — единственный, поэтому он и был «главным», а значение
 *    пряталось только при семи цифрах: три ключа из четырёх ложились в
 *    `mcp_tool_calls.arg_value` целиком, и их показывала админка. Ключ в
 *    открытом виде в базе — второй ключ от заявки: по нему читают статус,
 *    пишут адресату, а с change_request — отменяют и переносят.
 */

/** Какой аргумент считать главным — первый найденный из этого порядка. */
const PRIMARY_KEYS = [
  'name', 'place', 'volcano', 'tour', 'tours', 'query', 'task', 'date', 'date_from',
  'when', 'interests', 'location', 'activity_type', 'days',
] as const;

export const ARG_VALUE_MAX = 40;
export const HIDDEN_VALUE = '[скрыто]';

const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Аргументы, чьё значение — секрет: в журнал идёт только имя. */
const SECRET_ARG_KEYS: ReadonlySet<string> = new Set(['key']);

/**
 * Отрезок, похожий на ключ заявки, — где бы в значении он ни стоял и под каким
 * бы именем аргумента ни пришёл: ключ в кавычках или с приставкой («key: …»,
 * `sq_…`) — тот же ключ (ревью безопасности к #3280).
 *
 * Отрезок — 20+ знаков base64url подряд. Ключом считается отрезок с цифрой
 * либо любой отрезок от 32 знаков: ключ — ровно 32 случайных знака, и без
 * единой цифры он тоже бывает (доля (54/64)^32, около 0,4%). Название места
 * латиницей («Petropavlovsk-Kamchatsky», 24 знака без цифр) остаётся.
 */
const KEY_RUN = /[A-Za-z0-9_-]{20,}/g;
const KEY_LENGTH = 32;

function carriesKey(s: string): boolean {
  return (s.match(KEY_RUN) ?? []).some((run) => run.length >= KEY_LENGTH || /\d/.test(run));
}

/** Значение годится в журнал: не телефон (7+ цифр подряд с разделителями), не почта и без ключа заявки. */
export function safeArgValue(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, '').length;
  if (digits >= 7 || s.includes('@') || carriesKey(s)) return HIDDEN_VALUE;
  return s.slice(0, ARG_VALUE_MAX);
}

export interface PrimaryArg {
  key: string | null;
  value: string | null;
}

/**
 * Главный аргумент вызова. `nameOnly` — только имя аргумента, значение не
 * пишется никогда: у заявок там имя и телефон человека, у инструментов,
 * которым передают ключ заявки (`KEY_ARG_TOOL_NAMES`), — сам ключ, под каким
 * бы именем аргумента он ни пришёл.
 */
export function primaryArg(args: Record<string, unknown>, nameOnly: boolean): PrimaryArg {
  const keys = Object.keys(args);
  if (keys.length === 0) return { key: null, value: null };
  const key = PRIMARY_KEYS.find(k => k in args && args[k] != null && args[k] !== '') ?? keys[0];
  const safeKey = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key) ? key : 'не-идентификатор';
  if (nameOnly) return { key: safeKey, value: null };
  const value = safeArgValue(args[key]);
  // Секретный аргумент: значение было — пишется, что оно скрыто; пустое остаётся пустым.
  return { key: safeKey, value: value !== null && SECRET_ARG_KEYS.has(key) ? HIDDEN_VALUE : value };
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
