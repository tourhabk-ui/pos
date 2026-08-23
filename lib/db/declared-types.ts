/**
 * lib/db/declared-types.ts
 *
 * Одна колонка — два объявления. Какое из них лежит на проде, неизвестно.
 *
 * Перепись расхождений (`schema-drift`) сверяет ПРИСУТСТВИЕ: объявлено —
 * есть ли. Она слепа к случаю, когда колонка есть, но не та: объявлена
 * `TEXT[]` в одном файле и `TEXT` в другом. Между тем именно этот случай
 * дважды за сутки едва не привёл к порче живых данных:
 *
 *   • `operator_commissions.booking_id` — 084 объявляет UUID, живая бронь
 *     BIGINT. Ремонтная миграция 907 писалась по фактической схеме прода
 *     именно поэтому: доигрывание старого DDL завело бы колонку, в которую
 *     нельзя положить существующий id;
 *   • `operator_tours.includes` — 114 объявляет TEXT[], 690 объявляет TEXT.
 *     114 идёт одной транзакцией и первой строкой трогает `tours`; если она
 *     откатилась, на проде лежит TEXT из 690, а код читает массив.
 *
 * Опасность не в самом расхождении, а в РЕМОНТЕ вслепую. Увидев «колонки
 * нет», легко доиграть исходный DDL — и получить тип, несовместимый с уже
 * лежащими данными или с кодом. Поэтому конфликт объявлений обязан быть
 * ВИДЕН до того, как кто-то возьмётся чинить.
 *
 * Проверка чистая: ни сети, ни базы, только файлы миграций. Она отвечает не
 * на вопрос «какой тип на проде» (этого репозиторий знать не может — это
 * честное «не знаю», и меряется оно `information_schema`), а на вопрос
 * «сколько разных ответов даёт сам репозиторий».
 */

/** Слова, после которых тип колонки кончился и начались свойства. */
const TYPE_STOP = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK',
  'GENERATED', 'COLLATE', 'CONSTRAINT', 'DEFERRABLE',
]);

/**
 * Разные написания одного типа. Postgres принимает и то и другое, и считать
 * их конфликтом значило бы поднимать ложную тревогу — а на ложную тревогу
 * перестают смотреть.
 */
const ALIASES: Record<string, string> = {
  'INT': 'INTEGER',
  'INT4': 'INTEGER',
  'INT8': 'BIGINT',
  'INT2': 'SMALLINT',
  'BOOL': 'BOOLEAN',
  'DECIMAL': 'NUMERIC',
  'TIMESTAMPTZ': 'TIMESTAMP WITH TIME ZONE',
  'TIMESTAMP WITHOUT TIME ZONE': 'TIMESTAMP',
  'CHARACTER VARYING': 'VARCHAR',
  'DOUBLE PRECISION': 'FLOAT8',
  'FLOAT': 'FLOAT8',
};

export interface Declaration {
  file: string;
  /** Тип как написан в файле — для человека. */
  raw: string;
  /** Нормализованный — для сравнения. */
  normalized: string;
}

export interface TypeConflict {
  table: string;
  column: string;
  declarations: Declaration[];
  /**
   * Расходится ли БАЗОВЫЙ тип, или только его параметр.
   *
   * `VARCHAR(50)` против `VARCHAR(255)` — тоже расхождение, но чинится
   * безболезненно и данных не рвёт. `TEXT[]` против `TEXT` — рвёт. Мешать
   * их в одну кучу значит утопить второе в первом.
   */
  base_differs: boolean;
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
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

/** Разбить тело по запятым ВЕРХНЕГО уровня: `NUMERIC(10,2)` не должен рваться. */
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

/**
 * Обрезать строку по первой запятой или точке с запятой ВЕРХНЕГО уровня.
 *
 * Наивное `[^,;]+` резало объявление внутри параметра типа: `DECIMAL(10,2)`
 * превращалось в `DECIMAL(10`, и разбор объявлял конфликт `NUMERIC(10,2)`
 * против `DECIMAL(10` — там, где обе записи взяты из ОДНОГО файла и означают
 * одно и то же. Инструмент, ищущий расхождения типов, порождал их сам:
 * первый прогон дал так семь призраков из тридцати двух (`gear_items.rating`,
 * `ai_actions_log.cost_usd` и прочие).
 */
function cutAtTopLevel(s: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if ((s[i] === ',' || s[i] === ';') && depth <= 0) return s.slice(0, i);
  }
  return s;
}

/**
 * Взять тип из объявления, оборвав его на первом свойстве.
 *
 * Возвращает пустую строку, если типа нет вовсе, — например у ограничения,
 * прикинувшегося колонкой. Пустое молча отбрасывается вызывающим: догадка о
 * типе хуже отсутствия записи (§4.0).
 */
export function extractType(afterName: string): string {
  const tokens = afterName.trim().split(/\s+/);
  const out: string[] = [];
  for (const t of tokens) {
    const bare = t.replace(/[,;]+$/, '');
    if (TYPE_STOP.has(bare.toUpperCase())) break;
    out.push(bare);
    // Массив и параметр — часть типа, но дальше уже свойства.
    if (/\)$/.test(bare) || /\]$/.test(bare)) break;
  }
  return out.join(' ').trim();
}

/** Привести написание к одному виду, чтобы сравнивать типы, а не орфографию. */
export function normalizeType(raw: string): string {
  let t = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  // `TEXT []` и `TEXT[]` — одно и то же.
  t = t.replace(/\s*\[\s*\]/g, '[]');
  const arr = t.endsWith('[]');
  if (arr) t = t.slice(0, -2).trim();
  // `SERIAL` — не тип, а сокращение для INTEGER с последовательностью;
  // сравнивать его с INTEGER как разные значило бы врать.
  if (t === 'SERIAL') t = 'INTEGER';
  if (t === 'BIGSERIAL') t = 'BIGINT';
  const params = t.match(/^([A-Z ]+?)\s*(\([^)]*\))$/);
  const base = params ? params[1].trim() : t;
  const suffix = params ? params[2].replace(/\s+/g, '') : '';
  const canonical = ALIASES[base] ?? base;
  return `${canonical}${suffix}${arr ? '[]' : ''}`;
}

/** Базовый тип без параметра и без массива — для различения родов расхождения. */
function baseOf(normalized: string): string {
  return normalized.replace(/\(.*\)/, '').replace(/\[\]$/, '');
}

/**
 * Найти колонки, объявленные разными типами.
 *
 * Файлы подаются В ПОРЯДКЕ ИМЁН — тем же, в каком их накатывает раннер.
 * Порядок сохраняется в `declarations`, чтобы было видно, какое объявление
 * пришло позже.
 */
export function findTypeConflicts(files: Array<{ name: string; sql: string }>): TypeConflict[] {
  const seen = new Map<string, Declaration[]>();

  const put = (table: string, column: string, file: string, raw: string) => {
    if (!raw) return; // тип не разобран — молчим, а не выдумываем
    const key = `${table}.${column}`;
    const normalized = normalizeType(raw);
    const list = seen.get(key) ?? [];
    // Повтор того же типа тем же или другим файлом конфликтом не является:
    // `ADD COLUMN IF NOT EXISTS` намеренно идемпотентен и часто дублируется.
    if (!list.some((d) => d.normalized === normalized)) {
      list.push({ file, raw, normalized });
    }
    seen.set(key, list);
  };

  for (const { name, sql: rawSql } of files) {
    const sql = stripComments(rawSql);

    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z_]\w*)"?\s*\(/gi)) {
      const body = balancedBody(sql, m.index + m[0].length - 1);
      for (const def of splitTopLevel(body)) {
        const c = def.trim().match(/^"?([a-z_]\w*)"?\s+([\s\S]+)$/);
        if (!c) continue;
        if (TYPE_STOP.has(c[1].toUpperCase())) continue;
        if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE', 'LIKE'].includes(c[1].toUpperCase())) continue;
        put(m[1], c[1], name, extractType(c[2]));
      }
    }

    for (const m of sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?(?:public\.)?"?([a-z_]\w*)"?\s+([\s\S]*?);/gi)) {
      for (const a of m[2].matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?([a-z_]\w*)"?\s+/gi)) {
        const rest = m[2].slice(a.index + a[0].length);
        put(m[1], a[1], name, extractType(cutAtTopLevel(rest)));
      }
    }
  }

  const conflicts: TypeConflict[] = [];
  for (const [key, declarations] of seen) {
    if (declarations.length < 2) continue;
    const dot = key.lastIndexOf('.');
    const bases = new Set(declarations.map((d) => baseOf(d.normalized)));
    const arrays = new Set(declarations.map((d) => d.normalized.endsWith('[]')));
    conflicts.push({
      table: key.slice(0, dot),
      column: key.slice(dot + 1),
      declarations,
      base_differs: bases.size > 1 || arrays.size > 1,
    });
  }

  return conflicts.sort((a, b) =>
    a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
}
