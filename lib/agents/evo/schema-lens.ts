/**
 * Детерминированный объектив: запрос против схемы.
 *
 * Два настоящих дефекта 23.08 были одного рода — код спорил со схемой, и
 * прочёс их не увидел, потому что читает файлы по одному, а со схемой не
 * сверяется вовсе. В тот же день его судья объявил «по делу: 0».
 *
 * Здесь сравниваются два списка, а не работает угадыватель:
 *
 *  1. СОЕДИНЕНИЕ ПО ВНЕШНЕМУ КЛЮЧУ. Если `a.col` — колонка с внешним ключом,
 *     то `a.col = b.other` обязано вести в ту таблицу и ту колонку, которые
 *     объявлены ключом. Так ловится `JOIN users u ON u.id = t.operator_id`
 *     при `operator_tours.operator_id REFERENCES partners(id)`: оба id типа
 *     uuid, Постгрес не спорит, соединение просто не совпадает никогда.
 *
 *  2. КОЛОНКИ, КОТОРОЙ НЕТ. `u.company_name` при известном `u = users`, где
 *     такой колонки нет: запрос падает на проде, а в коде выглядит здраво.
 *
 * Молчим всюду, где не уверены. Таблица не найдена в схеме (вьюха, CTE,
 * подзапрос, таблица вне реестра) — проверки нет: «не знаю» не выдаётся ни
 * за «хорошо», ни за «плохо» (§4.0 CLAUDE.md).
 */

import type { SchemaModel } from '@/lib/agents/evo/schema-model';

/**
 * Таблицы, которые платформа объявила заменёнными (CLAUDE.md §4), и их замены.
 *
 * Внешние ключи на них в схеме остались со старых времён: `reviews.tour_id`
 * до сих пор объявлен ссылкой на мёртвую `tours`, хотя код давно соединяет с
 * `operator_tours` — и делает это ПРАВИЛЬНО. Клеймить такое соединение значит
 * ругать код за то, что он ушёл вперёд схемы. Устаревший ключ — отдельный
 * разговор с владельцем, а не находка о файле.
 */
const REPLACED: Record<string, readonly string[]> = {
  tours: ['operator_tours'],
  bookings: ['operator_bookings'],
  agent_route_knowledge: ['places', 'kamchatka_routes'],
};

export interface SchemaMismatch {
  file: string;
  line: number;
  kind: 'fk_join_mismatch' | 'unknown_column';
  /** Готовая фраза для находки — без домыслов, только факт. */
  message: string;
}

/** Литерал похож на SQL. */
const SQL_WORD = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;

/** `FROM t alias`, `JOIN t AS alias`, `UPDATE t`, `INSERT INTO t`. */
const SOURCE_RE =
  /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?(?:\s+(?:AS\s+)?"?([a-z_][a-z0-9_]*)"?)?/gi;

/** Слова, которые могут стоять после имени таблицы и не являются алиасом. */
const NOT_AN_ALIAS = new Set([
  'on', 'where', 'set', 'values', 'join', 'inner', 'left', 'right', 'full',
  'outer', 'cross', 'lateral', 'using', 'group', 'order', 'limit', 'having',
  'returning', 'select', 'and', 'or', 'as', 'union', 'except', 'intersect',
]);

/** Сравнения вида `a.col = b.col` — то, из чего состоит соединение. */
const JOIN_EQ =
  /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*=\s*([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;

/** Обращение к колонке через алиас. */
const ALIAS_COL = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;

/**
 * Обращение к колонке БЕЗ алиаса: `WHERE transfer_operator_id = $1`.
 *
 * Одностолбовые запросы алиасов не ставят, и объектив их не видел вовсе:
 * агентство трансферов спрашивало несуществующий `transfer_operator_id`
 * тремя запросами, а в улов попал только один — тот, где случился JOIN.
 *
 * Берём лишь позиции, где имя заведомо колонка, а не функция и не ключевое
 * слово: после `WHERE`/`AND`/`OR`/`SET`/`ON` и перед сравнением, `IS`, `IN`.
 * Судим ТОЛЬКО когда в запросе ровно одна таблица — иначе непонятно, чья
 * колонка, и «не знаю» молчит (§4.0).
 */
const BARE_COL =
  /\b(?:WHERE|AND|OR|SET|ON)\s+"?([a-z_][a-z0-9_]*)"?\s*(?:=|<>|!=|>=|<=|>|<|\bIS\b|\bIN\b|\bNOT\s+IN\b|\bLIKE\b|\bILIKE\b)/gi;

/** Слова, которые синтаксически стоят там же, но колонками не являются. */
const NOT_A_COLUMN = new Set([
  'not', 'exists', 'true', 'false', 'null', 'case', 'when', 'then', 'else',
  'select', 'date', 'lower', 'upper', 'coalesce', 'count', 'sum', 'max', 'min',
  'current_date', 'current_timestamp', 'now', 'any', 'all', 'conflict', 'do',
]);

/**
 * Комментарии SQL — прозой, а не кодом.
 *
 * Запрос объясняет сам себя: `-- ta.operator_tour_id, а НЕ ta.tour_id` — это
 * предупреждение о колонке, которой нет, и объектив клеймил его как её
 * употребление. Судить надо по коду, а не по тексту рядом с ним.
 *
 * Затираем пробелами, длину и переводы строк сохраняем: номер строки в находке
 * считается по смещению.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

interface Literal { body: string; start: number }

/** Шаблонные литералы файла с вырезанными `${…}`. */
function sqlLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '`') continue;
    const end = src.indexOf('`', i + 1);
    if (end === -1) break;
    const raw = src.slice(i + 1, end);
    if (SQL_WORD.test(raw)) {
      // Интерполяции заменяем пробелами: их содержимое к схеме отношения не
      // имеет, а скобки внутри сбивают разбор.
      out.push({ body: stripSqlComments(raw).replace(/\$\{[^}]*\}/g, ' '), start: i + 1 });
    }
    i = end;
  }
  return out;
}

/** alias → table для одного литерала. Имя таблицы само себе алиас. */
function aliasMap(body: string): Map<string, string> {
  const map = new Map<string, string>();
  SOURCE_RE.lastIndex = 0;
  for (let m = SOURCE_RE.exec(body); m; m = SOURCE_RE.exec(body)) {
    const table = m[1].toLowerCase();
    map.set(table, table);
    const alias = m[2]?.toLowerCase();
    if (alias && !NOT_AN_ALIAS.has(alias)) map.set(alias, table);
  }
  return map;
}

function lineOf(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

/**
 * Проверить один исходник. Чистая функция: путь нужен только для сообщения.
 */
export function scanSourceAgainstSchema(
  file: string,
  src: string,
  schema: SchemaModel,
): SchemaMismatch[] {
  if (schema.columns.size === 0) return []; // схемы нет — судить нечем
  const out: SchemaMismatch[] = [];

  for (const lit of sqlLiterals(src)) {
    const aliases = aliasMap(lit.body);
    const known = (alias: string): string | null => {
      const t = aliases.get(alias);
      return t && schema.columns.has(t) ? t : null;
    };

    // 1. Соединение по внешнему ключу.
    JOIN_EQ.lastIndex = 0;
    for (let m = JOIN_EQ.exec(lit.body); m; m = JOIN_EQ.exec(lit.body)) {
      const [, aA, cA, aB, cB] = m.map((x) => x.toLowerCase());
      const tA = known(aA);
      const tB = known(aB);
      if (!tA || !tB) continue; // одна из сторон не таблица — молчим

      for (const [near, nearCol, far, farCol] of [
        [tA, cA, tB, cB],
        [tB, cB, tA, cA],
      ] as const) {
        const fk = schema.foreignKeys.get(`${near}.${nearCol}`);
        if (!fk) continue;
        if (fk.refTable === far && fk.refColumn === farCol) continue;
        // Ключ ведёт в ЗАМЕНЁННУЮ таблицу — значит он сам устарел и судить им
        // нельзя ничего. Перечислять «законных преемников» мы пробовали, и
        // список сразу оказался неполон: отзывы о МАРШРУТАХ соединяют
        // reviews.tour_id с kamchatka_routes.ark_id (осознанно, это записано в
        // шапке запроса), а ключ всё ещё показывает на мёртвую `tours`.
        // Мёртвый ключ — это «не знаю», а не «плохо» (§4.0).
        if (REPLACED[fk.refTable]) continue;
        // Вторая сторона тоже может быть ключом в ту же цель — тогда это
        // законное соединение двух ссылок на одну таблицу, а не ошибка.
        const farFk = schema.foreignKeys.get(`${far}.${farCol}`);
        if (farFk && farFk.refTable === fk.refTable && farFk.refColumn === fk.refColumn) continue;
        out.push({
          file,
          line: lineOf(src, lit.start + m.index),
          kind: 'fk_join_mismatch',
          message:
            `${near}.${nearCol} ссылается на ${fk.refTable}.${fk.refColumn} внешним ключом, ` +
            `а соединяется с ${far}.${farCol} — совпадений не будет`,
        });
        break;
      }
    }

    // 2. Колонка, которой нет в таблице.
    ALIAS_COL.lastIndex = 0;
    for (let m = ALIAS_COL.exec(lit.body); m; m = ALIAS_COL.exec(lit.body)) {
      const alias = m[1].toLowerCase();
      const col = m[2].toLowerCase();
      const table = known(alias);
      if (!table) continue;
      const cols = schema.columns.get(table);
      if (!cols || cols.has(col)) continue;
      out.push({
        file,
        line: lineOf(src, lit.start + m.index),
        kind: 'unknown_column',
        message: `в таблице ${table} нет колонки ${col} — запрос упадёт`,
      });
    }

    // 3. Колонка без алиаса — только когда таблица в запросе одна.
    const tables = new Set([...aliases.values()]);
    if (tables.size === 1) {
      const table = [...tables][0];
      const cols = schema.columns.get(table);
      if (cols) {
        BARE_COL.lastIndex = 0;
        for (let m = BARE_COL.exec(lit.body); m; m = BARE_COL.exec(lit.body)) {
          const col = m[1].toLowerCase();
          if (NOT_A_COLUMN.has(col) || cols.has(col)) continue;
          out.push({
            file,
            line: lineOf(src, lit.start + m.index),
            kind: 'unknown_column',
            message: `в таблице ${table} нет колонки ${col} — запрос упадёт`,
          });
        }
      }
    }
  }

  return out;
}

/**
 * Находки объектива как записи прочёса.
 *
 * Категория `bug`, а не `tech_debt`: несовпадение с внешним ключом даёт пустую
 * выборку, а обращение к несуществующей колонке — падение запроса. И то и
 * другое ломает работу, а не мешает её читать.
 *
 * Тяжесть `high` у соединения и `critical` у несуществующей колонки: первое
 * молчит и потому живёт годами, второе кричит сразу — но кричит уже на проде.
 */
export function schemaMismatchToIssue(m: SchemaMismatch): {
  category: 'bug';
  severity: 'critical' | 'high';
  file_path: string;
  line_number: number;
  title: string;
  description: string;
  suggestion: string;
} {
  const isColumn = m.kind === 'unknown_column';
  return {
    category: 'bug',
    severity: isColumn ? 'critical' : 'high',
    file_path: m.file,
    line_number: m.line,
    title: isColumn ? 'Обращение к несуществующей колонке' : 'Соединение мимо внешнего ключа',
    description: m.message,
    suggestion: isColumn
      ? 'Сверить имя колонки со схемой (baseline + миграции). Если колонка нужна — завести миграцией; если переименована — поправить запрос.'
      : 'Соединять по колонке, объявленной внешним ключом. Если ключ устарел и код прав — переобъявить ключ миграцией, а не подгонять запрос.',
  };
}
