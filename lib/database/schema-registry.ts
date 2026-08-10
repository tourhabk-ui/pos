/**
 * Реестр схемы БД, собранный из migrations/*.sql — детерминированный источник
 * правды «какие колонки существуют» (Эволюция 2.0, пакет B, владелец 08.08).
 *
 * Зачем: код дважды ссылался на выдуманные колонки operator_bookings
 * (guests_count, #1007) и operator_tours (tour_type — колонки нет ни в одной
 * миграции, роут слотов групповых туров отдавал 500 всегда и похоронен в
 * #1008). Класс ошибки
 * «SQL против несуществующей схемы» не ловится ни tsc, ни vitest без БД —
 * ловится только сверкой с миграциями. Реестр кормит сторож
 * tests/unit/sql-phantom-columns.test.ts.
 *
 * Парсер сознательно КОНСЕРВАТИВЕН — ошибается в сторону «колонка есть»:
 * - DROP COLUMN игнорируется (колонка остаётся в реестре);
 * - RENAME COLUMN добавляет новое имя, не удаляя старое;
 * - VIEW и MATERIALIZED VIEW регистрируются как wildcard (любая колонка);
 * - динамический DDL (EXECUTE format) не парсится — его таблицы просто
 *   не попадают в реестр, и сторож их пропускает.
 * Ложное «фантом!» на живой колонке дороже, чем пропущенный фантом.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SchemaRegistry {
  /** таблица → множество колонок (нижний регистр) */
  tables: Map<string, Set<string>>;
  /** view/materialized view — любые колонки допустимы */
  views: Set<string>;
  /**
   * Таблицы, у которых разобрано полное тело CREATE TABLE (...). Таблица,
   * известная только по ALTER-ам (например, созданная через CREATE TABLE AS
   * SELECT — как places), имеет неполный список колонок, и проверять её
   * нечестно — сторож такие пропускает.
   */
  created: Set<string>;
}

const CONSTRAINT_STARTERS = /^(CONSTRAINT|PRIMARY\s|FOREIGN\s|UNIQUE\s*[(,]|UNIQUE\s*$|CHECK\s*\(|EXCLUDE\s|LIKE\s)/i;

/** Срезает SQL-комментарии: -- до конца строки и блочные. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Разбивает тело CREATE TABLE на определения по запятым нулевой глубины. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Тело скобок CREATE TABLE с учётом вложенности. */
function extractParenBody(src: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return null;
}

const ident = (s: string) => s.replace(/^"|"$/g, '').toLowerCase();

/** Применяет DDL одного SQL-текста к реестру. Экспортирован для тестов. */
export function applyDdl(sqlRaw: string, reg: SchemaRegistry): void {
  const sql = stripSqlComments(sqlRaw);

  // CREATE TABLE [IF NOT EXISTS] name ( ... )
  const ctRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = ctRe.exec(sql)) !== null) {
    const table = ident(m[1]).replace(/^public\./, '');
    const body = extractParenBody(sql, ctRe.lastIndex - 1);
    if (body === null) continue;
    const cols = reg.tables.get(table) ?? new Set<string>();
    for (const part of splitTopLevel(body)) {
      const def = part.trim();
      if (!def || CONSTRAINT_STARTERS.test(def)) continue;
      const cm = /^("?[\w]+"?)\s/.exec(def + ' ');
      if (cm) cols.add(ident(cm[1]));
    }
    reg.tables.set(table, cols);
    reg.created.add(table);
  }

  // ALTER TABLE name ... — один statement может нести НЕСКОЛЬКО ADD COLUMN
  // через запятую (migration 056: четыре ADD COLUMN одним ALTER).
  const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?[\w.]+"?)([^;]*)/gi;
  while ((m = alterRe.exec(sql)) !== null) {
    const table = ident(m[1]).replace(/^public\./, '');
    const clause = m[2];
    const cols = reg.tables.get(table) ?? new Set<string>();
    const addOne = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w]+"?)/gi;
    let am: RegExpExecArray | null;
    let touched = false;
    while ((am = addOne.exec(clause)) !== null) { cols.add(ident(am[1])); touched = true; }
    if (touched) reg.tables.set(table, cols);
  }

  // ALTER TABLE name RENAME COLUMN a TO b — добавляем b, старое имя оставляем
  const renRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)\s+RENAME\s+COLUMN\s+("?[\w]+"?)\s+TO\s+("?[\w]+"?)/gi;
  while ((m = renRe.exec(sql)) !== null) {
    const table = ident(m[1]).replace(/^public\./, '');
    const cols = reg.tables.get(table) ?? new Set<string>();
    cols.add(ident(m[3]));
    reg.tables.set(table, cols);
  }

  // VIEW / MATERIALIZED VIEW → wildcard
  const viewRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+("?[\w.]+"?)/gi;
  while ((m = viewRe.exec(sql)) !== null) {
    reg.views.add(ident(m[1]).replace(/^public\./, ''));
  }
}

/**
 * Собирает реестр из всех источников DDL проекта. Их два:
 * - migrations/*.sql — эволюция схемы (накатываются start.js при деплое);
 * - lib/database/*.sql — базовые *_schema.sql (partners, users, transfer_* и
 *   прочие таблицы, созданные до эры нумерованных миграций).
 * Кастомный список каталогов — для тестов парсера.
 */
export function buildSchemaRegistry(dirs?: string[]): SchemaRegistry {
  const roots = dirs ?? [join(process.cwd(), 'migrations'), join(process.cwd(), 'lib/database')];
  const reg: SchemaRegistry = { tables: new Map(), views: new Set(), created: new Set() };
  for (const dir of roots) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      applyDdl(readFileSync(join(dir, f), 'utf-8'), reg);
    }
  }
  return reg;
}

// ── Извлечение ссылок alias.column из SQL-литералов кода ──────────────────────

export interface ColumnRef {
  table: string;
  column: string;
}

const SQL_KEYWORD_NOT_ALIAS = new Set([
  'where', 'on', 'left', 'right', 'inner', 'outer', 'join', 'cross', 'full',
  'group', 'order', 'limit', 'offset', 'set', 'using', 'natural', 'union',
  'returning', 'lateral', 'as', 'and', 'or', 'not', 'values', 'select',
  'having', 'when', 'then', 'else', 'end', 'for', 'tablesample', 'except',
]);

/**
 * Вытаскивает из текста SQL проверяемые ссылки «таблица.колонка»:
 * - alias.column, где alias объявлен через FROM/JOIN/UPDATE/INSERT INTO;
 * - список колонок INSERT INTO table (a, b, c).
 * Подзапросные алиасы и таблицы вне FROM/JOIN не проверяются.
 */
export function extractColumnRefs(sqlRaw: string): ColumnRef[] {
  // Интерполяции превращаем в нейтральный токен: их содержимое — не SQL.
  const sql = sqlRaw.replace(/\$\{[^}]*\}/g, ' __expr__ ');

  const aliasToTable = new Map<string, string>();
  const claim = (table: string, alias?: string) => {
    const t = ident(table);
    aliasToTable.set(t, t);
    if (alias) {
      const a = ident(alias);
      if (!SQL_KEYWORD_NOT_ALIAS.has(a)) aliasToTable.set(a, t);
    }
  };

  let m: RegExpExecArray | null;
  const fromRe = /\b(?:FROM|JOIN)\s+("?[\w.]+"?)(?:\s+AS)?(?:\s+("?[a-zA-Z_][\w]*"?))?/gi;
  while ((m = fromRe.exec(sql)) !== null) claim(m[1].replace(/^public\./, ''), m[2]);
  const updRe = /\bUPDATE\s+(?:ONLY\s+)?("?[\w.]+"?)(?:\s+AS)?(?:\s+("?[a-zA-Z_][\w]*"?))?\s+SET\b/gi;
  while ((m = updRe.exec(sql)) !== null) claim(m[1].replace(/^public\./, ''), m[2]);

  const refs: ColumnRef[] = [];

  // INSERT INTO table (a, b, c)
  const insRe = /\bINSERT\s+INTO\s+("?[\w.]+"?)\s*\(([^)]*)\)/gi;
  while ((m = insRe.exec(sql)) !== null) {
    const table = ident(m[1]).replace(/^public\./, '');
    for (const raw of m[2].split(',')) {
      const c = raw.trim();
      if (/^"?[\w]+"?$/.test(c) && c !== '__expr__') refs.push({ table, column: ident(c) });
    }
  }

  // alias.column
  const refRe = /\b([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)\b/g;
  while ((m = refRe.exec(sql)) !== null) {
    const table = aliasToTable.get(m[1].toLowerCase());
    if (table) refs.push({ table, column: m[2].toLowerCase() });
  }

  // Голые колонки SELECT-списка — только в ОДНОтабличном запросе, где их
  // принадлежность однозначна (кейс похороненного роута #1008: `SELECT id,
  // tour_type, is_active FROM operator_tours` — фантом стоял без алиаса).
  const tablesUsed = new Set(aliasToTable.values());
  if (tablesUsed.size === 1) {
    const table = [...tablesUsed][0];
    const NOT_A_COLUMN = new Set([
      'distinct', 'all', 'case', 'when', 'then', 'else', 'end', 'null', 'true',
      'false', 'not', 'exists', 'interval', 'now', 'coalesce', 'count', 'sum',
      'min', 'max', 'avg', 'greatest', 'least', 'nullif', 'cast', 'extract',
      'current_date', 'current_timestamp', '__expr__',
    ]);
    const selRe = /\bSELECT\b([\s\S]*?)\bFROM\b/gi;
    let sm: RegExpExecArray | null;
    while ((sm = selRe.exec(sql)) !== null) {
      for (const rawItem of splitTopLevel(sm[1])) {
        // Приведение типа не меняет того, что слева от него стоит колонка:
        // `updated_at::text` — такая же ссылка, как голый `updated_at`.
        // Пока каст глушил весь элемент списка, гард пропустил фантом
        // danger_assessments.updated_at, и /api/public/danger-summary месяцами
        // отдавал пустоту вместо оценки риска по зонам — молча, через catch.
        const item = rawItem.trim().replace(/::\s*[\w[\]. ]+/g, '');
        // Функции, звёздочки, литералы, alias.col (уже учтён) — не голые колонки.
        if (!item || /[(*.'":]/.test(item)) continue;
        const im = /^([a-zA-Z_][\w]*)/.exec(item);
        if (!im) continue;
        const col = im[1].toLowerCase();
        if (NOT_A_COLUMN.has(col)) continue;
        refs.push({ table, column: col });
      }
    }
  }

  return refs;
}

/** Ссылки, которых нет в реестре: фантомные колонки. */
export function findPhantomRefs(sqlText: string, reg: SchemaRegistry): ColumnRef[] {
  const STAR = new Set(['*']);
  return extractColumnRefs(sqlText).filter(({ table, column }) => {
    if (STAR.has(column)) return false;
    if (reg.views.has(table)) return false;
    // Полного CREATE TABLE не видели (CTAS/динамический DDL) — список колонок
    // заведомо неполон, честной проверки не выйдет.
    if (!reg.created.has(table)) return false;
    const cols = reg.tables.get(table);
    if (!cols) return false; // таблица не из миграций — не наш предмет
    return !cols.has(column);
  });
}
