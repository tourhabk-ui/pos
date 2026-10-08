/**
 * Аргументы tools/call: что пришло и что из этого прочитано (08.10).
 *
 * Перепись журнала за 30 дней (prod-check run 98): двенадцать отказов
 * `invalid_args` у четырёх читающих инструментов с ПУСТЫМ главным аргументом.
 * `primaryArg` отвечает пустотой только на пустой объект — то есть после
 * разбора от аргументов не оставалось ничего. Роут превращал в `{}` всё, что
 * не объект, и строку JSON тоже: мост из формата OpenAI, где
 * `function.arguments` — строка, присылает `"{\"name\":\"Авачинский\"}"`, мы
 * её выбрасывали и отвечали «нужно указать name» — агенту, который name указал.
 *
 * Здесь два правила:
 *  - строка, в которой лежит JSON-объект, читается как объект: спецификация
 *    требует объект, но наказывать агента за чужой мост не за что;
 *  - всё прочее не-объектное по-прежнему читается как `{}` (инструменты без
 *    обязательных полей так и работали, ломать их незачем), но ФОРМА
 *    запоминается: если схема потом откажет, отказ скажет, что именно
 *    пришло, а журнал — коду `invalid_args:<форма>`. Пустота и «не объект»
 *    в журнале больше не одна строка.
 */

export type ArgumentsShape = 'object' | 'absent' | 'json_string' | 'string' | 'array' | 'other';

export interface ReadArguments {
  args: Record<string, unknown>;
  shape: ArgumentsShape;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function readToolArguments(raw: unknown): ReadArguments {
  if (raw === undefined || raw === null) return { args: {}, shape: 'absent' };
  if (isPlainObject(raw)) return { args: raw, shape: 'object' };
  if (typeof raw === 'string') {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Не JSON — не сбой, а ответ: форма 'string' уходит в отказ и в журнал.
      parsed = null;
    }
    return isPlainObject(parsed) ? { args: parsed, shape: 'json_string' } : { args: {}, shape: 'string' };
  }
  return { args: {}, shape: Array.isArray(raw) ? 'array' : 'other' };
}

const SHAPE_RU: Partial<Record<ArgumentsShape, string>> = {
  string: 'строкой, и в ней не JSON-объект',
  array: 'массивом',
  other: 'числом или логическим значением',
};

/**
 * Отказ схемы — текст агенту и код журнала. Текст схемы (какое поле нужно)
 * остаётся целиком; спереди — что пришло, если пришло не то, что можно
 * прочитать: иначе агент, передавший name, услышит «укажите name» и
 * повторит тот же вызов.
 */
export function argsRefusal(read: ReadArguments, schemaError: string): { message: string; code: string } {
  const what = SHAPE_RU[read.shape];
  if (what) {
    return {
      message: `Аргументы пришли ${what} — их нельзя прочитать: arguments должен быть объектом JSON. ${schemaError}`,
      code: `invalid_args:${read.shape}`,
    };
  }
  if (Object.keys(read.args).length === 0) {
    return { message: `Аргументы не пришли: объект arguments пуст. ${schemaError}`, code: 'invalid_args:empty' };
  }
  return { message: schemaError, code: 'invalid_args' };
}
