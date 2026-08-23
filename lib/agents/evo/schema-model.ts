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
 * плюс `ALTER TABLE … ADD COLUMN` из миграций. Чего в этих файлах нет — того
 * для проверки не существует, и мы об этом молчим, а не догадываемся.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\);/gi;
const FK = /ALTER TABLE (?:ONLY )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+ADD CONSTRAINT\s+\S+\s+FOREIGN KEY\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)\s*REFERENCES\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)/gi;
const ADD_COLUMN = /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?([\s\S]*?);/gi;
const ADD_COLUMN_NAME = /ADD COLUMN (?:IF NOT EXISTS )?"?([a-z_][a-z0-9_]*)"?/gi;
const CREATE_VIEW = /CREATE (?:OR REPLACE )?(?:MATERIALIZED )?VIEW (?:IF NOT EXISTS )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/** Строки тела CREATE TABLE, которые объявляют колонку, а не ограничение. */
function columnsOfBody(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line) continue;
    if (/^(CONSTRAINT|PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|EXCLUDE)\b/i.test(line)) continue;
    const m = /^"?([a-z_][a-z0-9_]*)"?\s+\S/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function absorb(sql: string, model: SchemaModel): void {
  // Вьюхи запоминаем ОТДЕЛЬНО и из состава колонок исключаем. Пример, ради
  // которого это заведено: agent_route_knowledge — сегодня VIEW поверх places
  // и kamchatka_routes (миграция 663), но старая одноимённая таблица осталась
  // в baseline. Судить запрос по её колонкам значит клеймить рабочий код.
  CREATE_VIEW.lastIndex = 0;
  for (let m = CREATE_VIEW.exec(sql); m; m = CREATE_VIEW.exec(sql)) {
    model.views.add(m[1].toLowerCase());
  }

  CREATE_TABLE.lastIndex = 0;
  for (let m = CREATE_TABLE.exec(sql); m; m = CREATE_TABLE.exec(sql)) {
    const table = m[1].toLowerCase();
    const set = model.columns.get(table) ?? new Set<string>();
    for (const c of columnsOfBody(m[2])) set.add(c.toLowerCase());
    model.columns.set(table, set);
  }

  FK.lastIndex = 0;
  for (let m = FK.exec(sql); m; m = FK.exec(sql)) {
    const [, table, column, refTable, refColumn] = m.map((x) => (x ?? '').toLowerCase());
    model.foreignKeys.set(`${table}.${column}`, { table, column, refTable, refColumn });
  }

  // ALTER TABLE … ADD COLUMN — миграции дописывают колонки годами, и без них
  // проверка «такой колонки нет» врала бы на каждой второй.
  ADD_COLUMN.lastIndex = 0;
  for (let m = ADD_COLUMN.exec(sql); m; m = ADD_COLUMN.exec(sql)) {
    const table = m[1].toLowerCase();
    const tail = m[2];
    if (!/ADD COLUMN/i.test(tail)) continue;
    const set = model.columns.get(table) ?? new Set<string>();
    ADD_COLUMN_NAME.lastIndex = 0;
    for (let c = ADD_COLUMN_NAME.exec(tail); c; c = ADD_COLUMN_NAME.exec(tail)) {
      set.add(c[1].toLowerCase());
    }
    model.columns.set(table, set);
  }
}

/** Собрать модель из baseline и миграций. `root` — корень репозитория. */
export function loadSchemaModel(root: string): SchemaModel {
  const model: SchemaModel = { columns: new Map(), foreignKeys: new Map(), views: new Set() };

  const baseline = join(root, 'lib/database/baseline/schema-baseline.sql');
  try {
    absorb(readFileSync(baseline, 'utf-8'), model);
  } catch {
    // Нет baseline — модель пустая, и все проверки поверх неё промолчат.
    // Это честнее, чем судить по обрывкам: см. §4.0, третий исход.
    return model;
  }

  const migrations = join(root, 'migrations');
  let files: string[] = [];
  try {
    files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
  } catch { /* миграций нет — работаем по baseline */ }
  for (const f of files) {
    try {
      absorb(readFileSync(join(migrations, f), 'utf-8'), model);
    } catch { /* один нечитаемый файл не должен ронять модель */ }
  }

  for (const v of model.views) model.columns.delete(v);

  return model;
}
