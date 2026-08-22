/**
 * Настоящие типы колонок таблицы — чтобы запись подстраивалась под схему,
 * а не схема под наши ожидания.
 *
 * История, стоившая недели. Миграция 056 объявила состав тура как `TEXT[]`,
 * но добавляла колонки через `ADD COLUMN IF NOT EXISTS`, а на проде они уже
 * существовали как `jsonb`. Такой ADD молча ничего не делает — расхождение
 * родилось бесшумно и жило год. Дальше всё ломалось по очереди: миграции,
 * писавшие `ARRAY[...]`, падали по типу; код, писавший `JSON.stringify`,
 * работал и тем закреплял расхождение; а владелец, пытавшийся поправить тур
 * руками, получал «invalid input syntax for type json» и не мог сохранить
 * ничего.
 *
 * Миграция 823 привела три колонки к объявленному типу. Но угадывать по одной,
 * какая ещё разошлась, — это тот же круг: правка, деплой, проверка, снова
 * правка. Поэтому запись больше не гадает. Она СПРАШИВАЕТ у базы, какой тип у
 * колонки, и сериализует значение соответственно.
 *
 * Так кабинет работает в любой схеме: и там, где колонки уже `TEXT[]`, и там,
 * где ещё `jsonb`. Схему мы всё равно приводим к одному виду миграциями — но
 * человек, правящий карточку, не должен ждать деплоя, чтобы нажать «Сохранить».
 *
 * Кэш живёт в памяти процесса: тип колонки меняется миграцией, то есть с
 * перезапуском контейнера, и переживать перезапуск ему незачем.
 */

import { pool } from '@/lib/db-pool';

/** column_name → udt_name ('_text' для TEXT[], 'jsonb'/'json' для JSON). */
type ColumnTypes = Map<string, string>;

const cache = new Map<string, Promise<ColumnTypes>>();

async function load(table: string): Promise<ColumnTypes> {
  const { rows } = await pool.query<{ column_name: string; udt_name: string }>(
    `SELECT column_name, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Map(rows.map((r) => [r.column_name, r.udt_name]));
}

/** Типы колонок таблицы. Один запрос на процесс. */
export function getColumnTypes(table: string): Promise<ColumnTypes> {
  let entry = cache.get(table);
  if (!entry) {
    // Неудачу не кэшируем: иначе одна сетевая икота отравила бы весь процесс.
    entry = load(table).catch((e) => { cache.delete(table); throw e; });
    cache.set(table, entry);
  }
  return entry;
}

// resetColumnTypesCache убрана 22.08.2026 (перепись).
//
// Сброс кэша типов колонок нужен тесту, который применил миграцию и хочет
// увидеть новый тип. Такого теста нет ни одного: кэш живёт в пределах
// процесса, а тесты схемы читают файлы, а не базу.

/**
 * Готовит значение к записи в колонку с учётом её настоящего типа.
 *
 * Массив в `TEXT[]` идёт как массив; в `json`/`jsonb` — как JSON-строка.
 * Перепутать нельзя ни в одну сторону: `JSON.stringify(['а','б'])` в `TEXT[]`
 * ляжет ОДНОЙ строкой с кавычками и скобками вместо двух пунктов, а массив в
 * `jsonb` не разберётся вовсе.
 *
 * Тип колонки неизвестен (её нет в схеме) — отдаём значение как есть: пусть
 * ошибётся Postgres и назовёт колонку, а не мы молча подменим смысл.
 */
export function valueForColumn(
  value: unknown,
  column: string,
  types: ColumnTypes,
): unknown {
  if (!Array.isArray(value)) return value;
  const udt = types.get(column);
  if (udt === 'json' || udt === 'jsonb') return JSON.stringify(value);
  return value;
}
