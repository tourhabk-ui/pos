/**
 * lib/db/schema-drift.ts
 *
 * Расхождение между тем, что миграции ОБЪЯВЛЯЮТ, и тем, что на боевой базе
 * ЕСТЬ.
 *
 * Зачем отдельно от `schema-facts`. Тот считает «не применилось» по ИМЕНАМ
 * файлов: файл образа, которого нет в `_migrations`. Такая проверка слепа к
 * целому классу поломок — файл записан как применённый, а действия его в
 * базе нет. Так бывает, когда файл откатился целиком (он идёт одной
 * транзакцией, падение любого оператора отменяет весь файл), а запись в
 * `_migrations` всё равно сделалась: дефект трекинга, разобранный в задаче
 * #58. В раннере он починен, но следы старых откатов остались в базе
 * навсегда, и по именам файлов их не увидеть — имя есть, действия нет.
 *
 * Чего это стоило один раз. 22.08 у `operator_bookings` нашлось 47 колонок
 * против 52 объявленных, при пустых `unapplied` и `failures`. Среди
 * пропавших — `user_id`, который перечисляют четыре из семи путей создания
 * брони: бронь с сайта не создавалась вовсе, а аудит показывал порядок.
 *
 * Проверка сравнивает две стороны и НИЧЕГО не выдумывает: слева — колонки
 * из `CREATE TABLE` и `ADD COLUMN` в migrations/, справа — `information_schema`
 * живой базы. Наружу уходят только имена таблиц, колонок и файлов: ответ
 * читают в логах Actions, значений из пользовательских данных в нём нет.
 *
 * Третий исход обязателен (§4.0). Если каталог миграций не читается или
 * база не отвечает, это «не смог проверить», а не «расхождений нет»:
 * поле `ok` равно false, и вызывающий обязан отличать одно от другого.
 */

/** Слова, которыми начинается не колонка, а ограничение внутри CREATE TABLE. */
const NOT_A_COLUMN = new Set(['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude', 'like']);

/**
 * Убрать комментарии SQL.
 *
 * Без этого хвостовой комментарий читается как объявление колонки: строка
 * `status VARCHAR(20) NOT NULL DEFAULT 'running',   -- running, complete, failed`
 * при разбиении по запятым верхнего уровня даёт кусок ` complete` и кусок
 * ` failed`, а следующий за ним перевод строки и имя настоящей колонки
 * складываются в «имя + пробел + слово» — то есть ровно в форму объявления.
 * Первый прогон переписи 22.08 выдал так десяток призраков: `evo_growth_issues.ux`,
 * `evo_growth_scans.security`, `operator_bookings.when` (из «-- if chose
 * alternative, when is it»). Перепись, которая ищет вранье в схеме, врала сама.
 *
 * Строковые литералы не щадим намеренно: `--` внутри кавычек в DDL этого
 * репозитория не встречается, а усложнять разбор ради небывалого случая —
 * заводить вторую возможность ошибиться.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, '');
}

/** Содержимое скобок, начинающихся в позиции `open`, со счётом вложенности. */
function balancedBody(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return sql.slice(open + 1);
}

/** Разбить тело объявления по запятым ВЕРХНЕГО уровня. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

export interface DeclaredSchema {
  /** таблица → колонка → имя файла, объявившего её первым */
  tables: Map<string, Map<string, string>>;
}

export interface DriftReport {
  /** false — проверить не удалось; список расхождений в этом случае ничего не значит. */
  ok: boolean;
  reason?: string;
  declared_tables: number;
  actual_relations: number;
  missing_tables: Array<{ table: string; declared_in: string }>;
  missing_columns: Array<{ table: string; column: string; declared_in: string }>;
}

/**
 * Колонки, объявленные файлами миграций. Порядок файлов важен: колонку
 * приписываем ПЕРВОМУ объявившему — он и есть тот, чьё действие потерялось.
 */
export function parseDeclarations(files: Array<{ name: string; sql: string }>): DeclaredSchema {
  const tables = new Map<string, Map<string, string>>();

  const put = (table: string, column: string, file: string) => {
    if (!tables.has(table)) tables.set(table, new Map());
    const cols = tables.get(table)!;
    if (!cols.has(column)) cols.set(column, file);
  };

  for (const { name, sql: raw } of files) {
    const sql = stripComments(raw);
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z_]\w*)"?\s*\(/gi)) {
      const table = m[1];
      if (!tables.has(table)) tables.set(table, new Map());
      // Тело читается со счётом скобок, а не регуляркой до первой `);`:
      // `VARCHAR(255)` и `CHECK (x > 0)` внутри объявления — обычное дело, и
      // на них разбор «до ближайшей скобки» обрывался бы посреди таблицы.
      const body = balancedBody(sql, m.index + m[0].length - 1);
      for (const def of splitTopLevel(body)) {
        const c = def.trim().match(/^"?([a-z_]\w*)"?\s+\S/);
        if (c && !NOT_A_COLUMN.has(c[1].toLowerCase())) put(table, c[1], name);
      }
    }

    for (const m of sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?(?:public\.)?"?([a-z_]\w*)"?\s+([\s\S]*?);/gi)) {
      for (const a of m[2].matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?([a-z_]\w*)"?/gi)) {
        put(m[1], a[1], name);
      }
    }

    // ── Снятое позже — не расхождение, а решение ───────────────
    //
    // Третья причина расхождений, найденная 22.08 уже после первого прогона:
    // колонка объявлена, а следом ДРУГАЯ миграция её удаляет. Так вышло с
    // `operator_tours.tags` (заведена в 040, снята в 041 — на её месте
    // `ai_tags`), `tour_availability.suggested_alternatives` и
    // `weather_alerts.affected_bookings`.
    //
    // Разбор этого не знал и звал такие колонки пропавшими. Беда не в цифре:
    // перепись подталкивала ВЕРНУТЬ то, что убрали намеренно. Ложная тревога
    // опаснее молчания — на неё перестают смотреть.
    //
    // Файлы идут по порядку имён, поэтому удаление действует на всё, что
    // объявлено раньше, и не трогает то, что заведут позже.
    for (const m of sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?(?:public\.)?"?([a-z_]\w*)"?\s+([\s\S]*?);/gi)) {
      for (const d of m[2].matchAll(/DROP COLUMN\s+(?:IF EXISTS\s+)?"?([a-z_]\w*)"?/gi)) {
        tables.get(m[1])?.delete(d[1]);
      }
    }

    for (const m of sql.matchAll(/DROP TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?"?([a-z_]\w*)"?/gi)) {
      tables.delete(m[1]);
    }
  }

  return { tables };
}

/**
 * Сверка с фактической схемой.
 *
 * `actual` — отношение → его колонки, включая ПРЕДСТАВЛЕНИЯ: таблица,
 * ставшая представлением (как `agent_route_knowledge`, миграция 663), не
 * пропала, и объявлять её пропавшей значило бы врать.
 *
 * `dropped` — имена, которые убраны сознательно: миграция объявляла, потом
 * объект удалили или переименовали. Список задаёт вызывающий, и он должен
 * быть явным — иначе «расхождений нет» достигается умолчанием.
 */
export function diffAgainstActual(
  declared: DeclaredSchema,
  actual: Map<string, Set<string>>,
  dropped: ReadonlySet<string> = new Set(),
): Omit<DriftReport, 'ok' | 'reason'> {
  const missing_tables: DriftReport['missing_tables'] = [];
  const missing_columns: DriftReport['missing_columns'] = [];

  for (const [table, columns] of declared.tables) {
    if (dropped.has(table)) continue;

    const actualCols = actual.get(table);
    if (!actualCols) {
      // Файл, объявивший таблицу, — первый из объявивших любую её колонку.
      const first = [...columns.values()].sort()[0] ?? '—';
      missing_tables.push({ table, declared_in: first });
      continue;
    }

    for (const [column, file] of columns) {
      if (dropped.has(`${table}.${column}`)) continue;
      if (!actualCols.has(column)) missing_columns.push({ table, column, declared_in: file });
    }
  }

  const byName = (a: { table: string }, b: { table: string }) => a.table.localeCompare(b.table);
  return {
    declared_tables: declared.tables.size,
    actual_relations: actual.size,
    missing_tables: missing_tables.sort(byName),
    missing_columns: missing_columns.sort(byName),
  };
}
