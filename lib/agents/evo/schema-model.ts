/**
 * Модель схемы БД, собранная из файлов репозитория.
 *
 * Зачем. Оба настоящих дефекта 23.08 были одного рода: КОД СПОРИТ СО СХЕМОЙ.
 * `UPDATE bookings` там, где ключ взят из `operator_bookings` (bigint против
 * uuid). `JOIN users u ON u.id = t.operator_id` на колонке, у которой внешний
 * ключ ведёт в `partners`. Прочёс не заметил ни того, ни другого и в тот же
 * день объявил «по делу: 0» — потому что читает файлы по одному и со схемой
 * не сверяется вовсе.
 *
 * Это не эвристика и не модель: два списка сравниваются между собой. Схему
 * выводим ровно оттуда, откуда её выводит платформа (CLAUDE.md §4): baseline
 * плюс миграции. Чего в этих файлах нет — того для проверки не существует, и
 * мы об этом молчим, а не догадываемся.
 *
 * 14.11 (#3343, до него #2891 и #3268): три «критические» находки подряд
 * оказались ложными по одной причине. Миграция 1349 создала таблицу
 * `stay_request_messages`, миграция 1350 переименовала её в
 * `request_messages` и дописала колонку. Модель переименования не понимала:
 * у нового имени оставались одни дописанные колонки, и каждое обращение к
 * `body`, `author`, `status` объявлялось «колонки нет — запрос упадёт». Замер
 * того дня: 101 находка объектива из 119 — от этого. Ещё 12 — от внешних
 * ключей, объявленных в миграциях рядом с колонкой (`REFERENCES` в строке
 * колонки): модель видела только форму baseline и не знала 160 ключей из 391.
 *
 * Отсюда правила разбора:
 *  - команды читаются ПО ПОРЯДКУ, и переименование таблицы и колонки
 *    переносит то, что уже известно, под новое имя; удалённая колонка
 *    перестаёт быть известной;
 *  - внешний ключ читается в любой записи: отдельной командой, строкой
 *    колонки, строкой таблицы;
 *  - комментарии SQL — не команды: откат в шапке миграции ничего не меняет;
 *  - поверх baseline доигрываются только миграции новее него, как на
 *    настоящей базе.
 *
 * Вывод о схеме делает сервер, а не разбор текста (тот же урок, что у запроса
 * 24.08). Поэтому модель сверяется с настоящей базой, собранной из тех же
 * файлов: tests/integration/schema-model.pg.test.ts — таблицы, колонки, ключи
 * и вьюхи обязаны совпасть. Миграция с записью, которую разбор не понял,
 * краснеет в своём PR, а не через две недели ложной находкой.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAfterBaseline, sortMigrations } from '@/lib/database/migration-order';
import { parseBaselineHeader } from '@/lib/database/baseline-header';

export interface ForeignKey {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export interface SchemaModel {
  /** table → набор известных колонок. ТОЛЬКО таблицы: вьюхи исключены. */
  columns: Map<string, Set<string>>;
  /** `table.column` → внешний ключ. */
  foreignKeys: Map<string, ForeignKey>;
  /** Имена вьюх: их состав выводится из запроса, судить по нему нельзя. */
  views: Set<string>;
}

const NAME = '"?([a-z_][a-z0-9_]*)"?';
const QUALIFIED = `(?:public\\.)?${NAME}`;

const CREATE_TABLE = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${QUALIFIED}\\s*\\(([\\s\\S]*?)\\n\\);`, 'gi');
const ALTER_TABLE = new RegExp(`ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${QUALIFIED}([\\s\\S]*?);`, 'gi');
const ADD_COLUMN_NAME = new RegExp(`ADD COLUMN (?:IF NOT EXISTS )?${NAME}`, 'gi');
const CREATE_VIEW = new RegExp(`CREATE (?:OR REPLACE )?(?:MATERIALIZED )?VIEW (?:IF NOT EXISTS )?${QUALIFIED}`, 'gi');

/** `FOREIGN KEY (col) REFERENCES t(col)` — отдельной командой или строкой таблицы. Составной ключ не читается. */
const FOREIGN_KEY = new RegExp(`FOREIGN KEY\\s*\\(\\s*${NAME}\\s*\\)\\s*REFERENCES\\s+${QUALIFIED}\\s*\\(\\s*${NAME}\\s*\\)`, 'gi');
/** `ADD COLUMN col тип … REFERENCES t(col)` — ключ в объявлении колонки. До запятой: одно действие команды. */
const ADD_COLUMN_FK = new RegExp(`ADD COLUMN (?:IF NOT EXISTS )?${NAME}\\s+[^,;]*?\\bREFERENCES\\s+${QUALIFIED}\\s*\\(\\s*${NAME}\\s*\\)`, 'gi');
/** `col тип … REFERENCES t(col)` — строка колонки в теле CREATE TABLE. */
const COLUMN_LINE_FK = new RegExp(`^${NAME}\\s+[^,]*?\\bREFERENCES\\s+${QUALIFIED}\\s*\\(\\s*${NAME}\\s*\\)`, 'i');

const DROP_COLUMN = new RegExp(`DROP COLUMN (?:IF EXISTS )?${NAME}`, 'gi');
const RENAME_TABLE = new RegExp(`^\\s*RENAME\\s+TO\\s+${QUALIFIED}\\s*$`, 'i');
const RENAME_COLUMN = new RegExp(`^\\s*RENAME\\s+(?:COLUMN\\s+)?${NAME}\\s+TO\\s+${NAME}\\s*$`, 'i');

/** Строка тела CREATE TABLE объявляет ограничение, а не колонку. */
const CONSTRAINT_LINE = /^(CONSTRAINT|PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|EXCLUDE)\b/i;

/**
 * Комментарии SQL — проза, а не команды.
 *
 * Шапка миграции 1350 кончается откатом: `-- ALTER TABLE request_messages
 * RENAME TO stay_request_messages;`. Прочитанный как команда, он переименовал
 * бы таблицу обратно. Строки в одинарных кавычках не трогаем: `--` внутри
 * текста — не комментарий.
 */
export function stripSqlComments(sql: string): string {
  const out: string[] = [];
  let kept = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      out.push(sql.slice(kept, i));
      while (i < sql.length && sql[i] !== '\n') i++;
      kept = i;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      out.push(sql.slice(kept, i), ' ');
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      kept = i;
      continue;
    }
    i++;
  }
  out.push(sql.slice(kept));
  return out.join('');
}

function setFk(model: SchemaModel, table: string, column: string, refTable: string, refColumn: string): void {
  model.foreignKeys.set(`${table}.${column}`, { table, column, refTable, refColumn });
}

/**
 * Тело CREATE TABLE: колонки и ключи, объявленные рядом с ними.
 *
 * Ключи читаются только у таблицы, которую модель видит впервые. Модель
 * накатывает baseline, а потом ВСЕ миграции, включая те, что старше него: на
 * настоящей базе их `CREATE TABLE IF NOT EXISTS` ничего не делает, таблица
 * уже есть. Прочитанный как действие, старый ключ затёр бы нынешний: у
 * `location_safety_profile.agent_route_id` в миграции 070 записано
 * `REFERENCES agent_route_knowledge(id)`, а в baseline — `places(ark_id)`.
 * Колонки при этом объединяются, как и раньше: лишняя известная колонка —
 * молчание объектива, а не ложная находка.
 */
function absorbTableBody(table: string, body: string, model: SchemaModel): void {
  const existed = model.columns.has(table);
  const set = model.columns.get(table) ?? new Set<string>();
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line) continue;
    if (CONSTRAINT_LINE.test(line)) {
      FOREIGN_KEY.lastIndex = 0;
      const fk = FOREIGN_KEY.exec(line);
      if (fk && !existed) setFk(model, table, fk[1].toLowerCase(), fk[2].toLowerCase(), fk[3].toLowerCase());
      continue;
    }
    // Имя колонки — строчными: строки-продолжения ограничений (`OR …`,
    // `AND …`, `REFERENCES …`) начинаются с заглавного слова и колонками не
    // считаются.
    const m = /^"?([a-z_][a-z0-9_]*)"?\s+\S/.exec(line);
    if (!m) continue;
    set.add(m[1]);
    const fk = COLUMN_LINE_FK.exec(line);
    if (fk && !existed) setFk(model, table, fk[1].toLowerCase(), fk[2].toLowerCase(), fk[3].toLowerCase());
  }
  model.columns.set(table, set);
}

/**
 * Таблицу переименовали: всё известное о старом имени переходит новому.
 *
 * Колонки объединяются, а не заменяются: миграция идемпотентна, и до
 * переименования под новым именем уже могли быть записаны дописанные колонки.
 */
function renameTable(from: string, to: string, model: SchemaModel): void {
  const old = model.columns.get(from);
  if (old) {
    const merged = model.columns.get(to) ?? new Set<string>();
    for (const c of old) merged.add(c);
    model.columns.set(to, merged);
    model.columns.delete(from);
  }
  for (const [key, fk] of [...model.foreignKeys]) {
    const table = fk.table === from ? to : fk.table;
    const refTable = fk.refTable === from ? to : fk.refTable;
    if (table === fk.table && refTable === fk.refTable) continue;
    model.foreignKeys.delete(key);
    setFk(model, table, fk.column, refTable, fk.refColumn);
  }
}

function renameColumn(table: string, from: string, to: string, model: SchemaModel): void {
  const set = model.columns.get(table);
  if (set) {
    set.delete(from);
    set.add(to);
  }
  for (const [key, fk] of [...model.foreignKeys]) {
    const column = fk.table === table && fk.column === from ? to : fk.column;
    const refColumn = fk.refTable === table && fk.refColumn === from ? to : fk.refColumn;
    if (column === fk.column && refColumn === fk.refColumn) continue;
    model.foreignKeys.delete(key);
    setFk(model, fk.table, column, fk.refTable, refColumn);
  }
}

/** Одна команда ALTER TABLE: дописанные колонки, ключи, переименования. */
function absorbAlter(table: string, tail: string, model: SchemaModel): void {
  const toTable = RENAME_TABLE.exec(tail);
  if (toTable) {
    renameTable(table, toTable[1].toLowerCase(), model);
    return;
  }
  const toColumn = RENAME_COLUMN.exec(tail);
  if (toColumn) {
    renameColumn(table, toColumn[1].toLowerCase(), toColumn[2].toLowerCase(), model);
    return;
  }

  // ALTER TABLE … ADD COLUMN — миграции дописывают колонки годами, и без них
  // проверка «такой колонки нет» врала бы на каждой второй.
  if (/ADD COLUMN/i.test(tail)) {
    const set = model.columns.get(table) ?? new Set<string>();
    // Ключ из объявления колонки — только у колонки, которой ещё не было:
    // `ADD COLUMN IF NOT EXISTS` у существующей колонки ничего не делает, и
    // её ключ остаётся прежним (то же правило, что у тела CREATE TABLE).
    const fresh = new Set<string>();
    ADD_COLUMN_NAME.lastIndex = 0;
    for (let c = ADD_COLUMN_NAME.exec(tail); c; c = ADD_COLUMN_NAME.exec(tail)) {
      const name = c[1].toLowerCase();
      if (!set.has(name)) fresh.add(name);
      set.add(name);
    }
    model.columns.set(table, set);
    ADD_COLUMN_FK.lastIndex = 0;
    for (let f = ADD_COLUMN_FK.exec(tail); f; f = ADD_COLUMN_FK.exec(tail)) {
      const name = f[1].toLowerCase();
      if (fresh.has(name)) setFk(model, table, name, f[2].toLowerCase(), f[3].toLowerCase());
    }
  }

  FOREIGN_KEY.lastIndex = 0;
  for (let f = FOREIGN_KEY.exec(tail); f; f = FOREIGN_KEY.exec(tail)) {
    setFk(model, table, f[1].toLowerCase(), f[2].toLowerCase(), f[3].toLowerCase());
  }

  // Удалённая колонка перестаёт быть известной вместе со своим ключом: иначе
  // запрос к ней объектив пропустил бы (миграция 1021 сняла у расписания
  // гида `tour_id` и `booking_id`).
  DROP_COLUMN.lastIndex = 0;
  for (let d = DROP_COLUMN.exec(tail); d; d = DROP_COLUMN.exec(tail)) {
    const name = d[1].toLowerCase();
    model.columns.get(table)?.delete(name);
    model.foreignKeys.delete(`${table}.${name}`);
  }
}

interface Command { at: number; apply: () => void }

/**
 * Прочитать один файл SQL в модель. Команды исполняются по порядку записи:
 * переименование видит то, что создано выше, а дописанная ниже колонка
 * ложится уже под новое имя.
 */
export function absorbSql(rawSql: string, model: SchemaModel): void {
  const sql = stripSqlComments(rawSql);

  // Вьюхи запоминаем ОТДЕЛЬНО и из состава колонок исключаем. Пример, ради
  // которого это заведено: agent_route_knowledge — сегодня VIEW поверх places
  // и kamchatka_routes (миграция 663), но старая одноимённая таблица осталась
  // в baseline. Судить запрос по её колонкам значит клеймить рабочий код.
  CREATE_VIEW.lastIndex = 0;
  for (let m = CREATE_VIEW.exec(sql); m; m = CREATE_VIEW.exec(sql)) {
    model.views.add(m[1].toLowerCase());
  }

  const commands: Command[] = [];
  CREATE_TABLE.lastIndex = 0;
  for (let m = CREATE_TABLE.exec(sql); m; m = CREATE_TABLE.exec(sql)) {
    const table = m[1].toLowerCase();
    const body = m[2];
    commands.push({ at: m.index, apply: () => absorbTableBody(table, body, model) });
  }
  ALTER_TABLE.lastIndex = 0;
  for (let m = ALTER_TABLE.exec(sql); m; m = ALTER_TABLE.exec(sql)) {
    const table = m[1].toLowerCase();
    const tail = m[2];
    commands.push({ at: m.index, apply: () => absorbAlter(table, tail, model) });
  }
  commands.sort((a, b) => a.at - b.at);
  for (const c of commands) c.apply();
}

/**
 * Собрать модель из baseline и миграций. `root` — корень репозитория.
 *
 * Поверх baseline доигрываются только миграции НОВЕЕ него — как на настоящей
 * базе и в шаблоне интеграционных тестов (граница — строка шапки baseline,
 * один разбор на всех: lib/database/baseline-header). До 14.11 доигрывались
 * все, включая вошедшие в снимок: у `operator_bookings` числилась колонка
 * `tour_id` из миграции до снимка, которой в базе нет, и запрос к ней объектив
 * пропустил бы; а старое объявление ключа спорило с нынешним.
 *
 * Граница не прочиталась — доигрываются все миграции и об этом сказано в
 * лог: лишние известные колонки дают молчание объектива, а не ложные находки.
 */
export function loadSchemaModel(root: string): SchemaModel {
  const model: SchemaModel = { columns: new Map(), foreignKeys: new Map(), views: new Set() };

  const baseline = join(root, 'lib/database/baseline/schema-baseline.sql');
  let firstAfter: number | null;
  try {
    const sql = readFileSync(baseline, 'utf-8');
    firstAfter = parseBaselineHeader(sql).firstAfter;
    absorbSql(sql, model);
  } catch {
    // Нет baseline — модель пустая, и все проверки поверх неё промолчат.
    // Это честнее, чем судить по обрывкам: см. §4.0, третий исход.
    return model;
  }

  const migrations = join(root, 'migrations');
  let files: string[] = [];
  try {
    files = sortMigrations(readdirSync(migrations).filter((f) => f.endsWith('.sql')));
  } catch { /* миграций нет — работаем по baseline */ }
  if (firstAfter === null) {
    console.error('[schema-model] в шапке baseline нет строки «Последняя миграция в снимке» — доигрываются все миграции');
  } else {
    const boundary = firstAfter;
    files = files.filter((f) => isAfterBaseline(f, boundary));
  }
  for (const f of files) {
    try {
      absorbSql(readFileSync(join(migrations, f), 'utf-8'), model);
    } catch { /* один нечитаемый файл не должен ронять модель */ }
  }

  for (const v of model.views) model.columns.delete(v);

  return model;
}
