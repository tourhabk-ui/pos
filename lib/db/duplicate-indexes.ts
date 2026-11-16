/**
 * lib/db/duplicate-indexes.ts — точные дубли индексов (#3388 п.4).
 *
 * Аудит схемы 15.11 назвал 30 пар индексов-дублей. Точный дубль совпадает
 * во всём: таблица, колонки и выражения, порядок сортировки, классы
 * операторов, правила сравнения, условие частичного индекса, метод доступа.
 * Второй такой индекс ничего не ускоряет, но каждая запись в таблицу
 * обновляет оба.
 *
 * Порядок сортировки (`indoption`) входит в сравнение намеренно: на модели
 * схемы без него выходило 30 пар — столько же назвал аудит, — с ним 28. Две
 * пары различаются направлением последней колонки:
 * `conversation_messages` (conversation_id, created_at DESC и ASC) и
 * `cancellation_policies` (partner_id, tour_id, days_before DESC и ASC). Для
 * выборки с обратным порядком по последней колонке это разные индексы, и
 * снимать их нельзя.
 *
 * Снимать их будет одна миграция с `DROP INDEX CONCURRENTLY` (слово владельца
 * в задаче). Эту команду нельзя обернуть в проверку «двойник на месте»: она не
 * выполняется в блоке транзакции и в функции. Поэтому сначала перепись на
 * самом проде — совпадают ли там пары с моделью схемы из репозитория, — а
 * потом миграция со списком, который эта перепись подтвердила.
 *
 * Какой из двух снимать — правило ниже, одно на перепись и миграцию:
 *  1. индекс, на котором держится ограничение (PRIMARY KEY, UNIQUE,
 *     исключение), остаётся: его не снять, не сняв правила;
 *  2. из двух без ограничения уникальный остаётся, если второй не уникален;
 *  3. иначе остаётся тот, чьё имя длиннее и подробнее называет колонки
 *     (`idx_loyalty_transactions_user_id`, а не `idx_lt_user`); при равной
 *     длине — первый по алфавиту. Это правило про имя, не про пользу: индексы
 *     одинаковы, и выбирается только то, что будет читаться в схеме.
 *
 * Только имена схемы — значений из таблиц перепись не читает.
 */

/** Группы одинаковых индексов. Только схема `public`. */
export const DUPLICATE_INDEXES_SQL = `
  WITH ix AS (
    SELECT x.indrelid,
           t.relname::text AS table_name,
           i.relname::text AS index_name,
           x.indisunique AS is_unique,
           x.indisprimary AS is_primary,
           EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid) AS backs_constraint,
           x.indkey::text AS k,
           x.indclass::text AS cl,
           x.indcollation::text AS co,
           x.indoption::text AS op,
           COALESCE(pg_get_expr(x.indexprs, x.indrelid), '') AS ex,
           COALESCE(pg_get_expr(x.indpred, x.indrelid), '') AS pr,
           am.amname::text AS am,
           pg_get_indexdef(x.indexrelid) AS def
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
     WHERE n.nspname = 'public'
  )
  SELECT table_name,
         json_agg(json_build_object(
           'name', index_name,
           'unique', is_unique,
           'primary', is_primary,
           'backs_constraint', backs_constraint,
           'def', def
         ) ORDER BY index_name) AS indexes
    FROM ix
   GROUP BY indrelid, table_name, k, cl, co, op, ex, pr, am
  HAVING COUNT(*) > 1
   ORDER BY table_name, MIN(index_name)`;

export interface IndexInGroup {
  name: string;
  unique: boolean;
  primary: boolean;
  backs_constraint: boolean;
  def: string;
}

export interface DuplicateGroup {
  table_name: string;
  indexes: IndexInGroup[];
}

export interface DropDecision {
  table: string;
  keep: string;
  drop: string[];
}

/** Какой индекс группы остаётся — правило из шапки файла. */
export function keeperOf(indexes: IndexInGroup[]): IndexInGroup {
  const rank = (i: IndexInGroup): [number, number, number] => [
    i.primary || i.backs_constraint ? 0 : 1,
    i.unique ? 0 : 1,
    -i.name.length,
  ];
  return [...indexes].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let k = 0; k < ra.length; k += 1) {
      if (ra[k] !== rb[k]) return ra[k] - rb[k];
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  })[0]!;
}

/**
 * План снятия: в каждой группе остаётся один. Индекс под ограничением не
 * снимается никогда — группа, где ограничений два, оставляет оба и уходит в
 * `blocked` с названной причиной.
 */
export function planDuplicateDrops(groups: DuplicateGroup[]): {
  drops: DropDecision[];
  blocked: Array<{ table: string; indexes: string[]; reason: string }>;
} {
  const drops: DropDecision[] = [];
  const blocked: Array<{ table: string; indexes: string[]; reason: string }> = [];
  for (const g of groups) {
    const keep = keeperOf(g.indexes);
    const others = g.indexes.filter((i) => i.name !== keep.name);
    const pinned = others.filter((i) => i.primary || i.backs_constraint);
    if (pinned.length > 0) {
      blocked.push({
        table: g.table_name,
        indexes: g.indexes.map((i) => i.name),
        reason: 'на двух индексах группы держатся ограничения — снимать ограничение отдельным решением',
      });
      continue;
    }
    drops.push({ table: g.table_name, keep: keep.name, drop: others.map((i) => i.name) });
  }
  return { drops, blocked };
}
