/**
 * lib/db/unmigrated-tables.ts
 *
 * Таблицы, форму которых репозиторий знает ТОЛЬКО из файлов, которые никогда
 * не накатываются.
 *
 * ── Что здесь не так ───────────────────────────────────────────────────────
 *
 * Реестр схемы (`lib/database/schema-registry.ts`) собирается из двух
 * каталогов: `migrations/` и `lib/database/*.sql`. Первый накатывается на прод
 * при каждом деплое через `start.js`. Второй не накатывается НИЧЕМ: его читает
 * один `scripts/migrate.js`, не подключённый ни к одной npm-команде.
 *
 * 22.08 старшинство уже развели: при повторном объявлении одной таблицы
 * побеждает миграция. Это закрыло случай `tour_availability`, где мёртвый файл
 * ручался за колонку `tour_id`, которой на проде нет.
 *
 * Но осталась половина, которую старшинство не трогает: таблицы, объявленные
 * ТОЛЬКО в мёртвых файлах. Спорить там не с чем — миграции о них молчат, — и
 * реестр принимает их форму как объявленную. Замер 23.08: таких таблиц 69 из
 * 86, и среди них `partners`, `users`, `tours`, `bookings`, `notifications`,
 * `payouts`, `guide_certifications` и весь модуль трансферов.
 *
 * ── Почему это именно «не знаю», а не «неверно» ────────────────────────────
 *
 * Мёртвый файл — смесь, и в этом вся беда. За один день 23.08 он оказался и
 * прав, и неправ:
 *
 *   прав   — `partners.contact` объявлен там как `JSONB NOT NULL`, и прод
 *            подтвердил это отказом 23502 на вставке без него;
 *   неправ — `tour_availability.tour_id` там же, а на проде живёт форма
 *            миграции 040.
 *
 * Значит объявить файл ложью нельзя (потеряем настоящие ограничения), и
 * принимать за истину нельзя тоже. Третье состояние (CLAUDE.md §4.0): форма
 * этих таблиц НЕ ПРОВЕРЕНА. Знать это по имени — уже польза: гард фантомных
 * колонок, ссылаясь на такую таблицу, ручается за то, чего не проверял, и
 * читающий его вердикт вправе знать цену этого вердикта.
 *
 * ── Что с этим делать (не здесь) ───────────────────────────────────────────
 *
 * Модуль только НАЗЫВАЕТ множество. Разрешает его сверка с боевой базой:
 * `/api/cron/schema-drift` спрашивает `information_schema` и говорит по каждой
 * такой таблице, есть ли она на проде и совпадают ли колонки. После сверки
 * каждая таблица уходит в одно из двух: настоящая миграция, повторяющая
 * боевую форму, — или удаление мёртвого объявления. Пока сверки нет, честный
 * ответ — «не знаю», и он должен быть виден.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Где лежат накатываемые миграции и где — мёртвые объявления. */
export const MIGRATIONS_DIR = 'migrations';
export const UNAPPLIED_DIR = 'lib/database';

/**
 * Имена таблиц, создаваемых в каталоге. Разбор нарочно грубый и совпадает с
 * тем, что делает реестр: `CREATE TABLE [IF NOT EXISTS] имя`. Тонкости
 * (партиции, `CREATE TABLE AS`) сюда не попадают и не должны: задача не в
 * полноте разбора, а в сравнении двух каталогов ОДНОЙ меркой.
 */
export function createdTables(dir: string, root = process.cwd()): Map<string, string> {
  const found = new Map<string, string>();
  const files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(root, dir, f), 'utf-8');
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const name = m[1].toLowerCase();
      // Первое объявление и есть источник: файлы отсортированы, а нам нужно
      // «кто завёл», а не «кто упоминал последним».
      if (!found.has(name)) found.set(name, f);
    }
  }
  return found;
}

export interface UnmigratedTable {
  table: string;
  /** Файл мёртвого каталога, где таблица объявлена. */
  declared_in: string;
}

/**
 * Таблицы, объявленные только в ненакатываемом каталоге.
 *
 * Возвращается отсортированным списком, а не множеством: список попадает в
 * ответ переписи и в сторож, и стабильный порядок там важнее удобства.
 */
export function unmigratedTables(root = process.cwd()): UnmigratedTable[] {
  const migrated = createdTables(MIGRATIONS_DIR, root);
  const unapplied = createdTables(UNAPPLIED_DIR, root);
  return [...unapplied.entries()]
    .filter(([table]) => !migrated.has(table))
    .map(([table, declared_in]) => ({ table, declared_in }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** Только имена — для быстрой проверки принадлежности. */
export function unmigratedTableNames(root = process.cwd()): Set<string> {
  return new Set(unmigratedTables(root).map((t) => t.table));
}
