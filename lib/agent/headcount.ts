/**
 * Число людей в заявке: один смысл — много имён (break-map 01.11).
 *
 * Внешние агенты присылают `participants_count`, `participants`, `guests`,
 * `passengers`, `guest_count`, `people`, `group_size` вперемешку: в тесте
 * 01.11 `create_booking_request` получил `guests: 5` и молча записал
 * participants=null. Здесь любое из имён переносится в каноническое для
 * данного инструмента, если каноническое не передано явно. Никакое
 * эквивалентное имя больше не теряется.
 */

export const HEADCOUNT_ALIASES = [
  'participants_count',
  'participants',
  'guests',
  'passengers',
  'guest_count',
  'guests_count',
  'people',
  'persons',
  'group_size',
  'pax',
] as const;

/** Каноническое имя поля числа людей у каждого заявочного инструмента/входа. */
export const HEADCOUNT_CANONICAL: Record<string, string> = {
  create_booking_request: 'participants',
  create_stay_request: 'guests',
  request_charter: 'passengers',
  create_trip_request: 'participants',
  rest_booking_create: 'participants_count',
};

function present(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
}

/** Первое переданное число людей под любым из имён (или undefined). */
export function pickHeadcount(args: Record<string, unknown>): unknown {
  for (const k of HEADCOUNT_ALIASES) if (present(args[k])) return args[k];
  return undefined;
}

/**
 * Копия аргументов с числом людей под каноническим именем `canonical`.
 * Синонимы удаляются, чтобы строгие схемы не спотыкались о лишнее поле.
 */
export function normalizeHeadcount(
  args: Record<string, unknown>,
  canonical: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const value = present(out[canonical]) ? out[canonical] : pickHeadcount(out);
  for (const k of HEADCOUNT_ALIASES) if (k !== canonical) delete out[k];
  if (value !== undefined) out[canonical] = value;
  return out;
}

export function normalizeToolHeadcount(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const canonical = HEADCOUNT_CANONICAL[tool];
  return canonical ? normalizeHeadcount(args, canonical) : args;
}
