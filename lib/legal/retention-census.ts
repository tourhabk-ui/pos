/**
 * Перепись сроков хранения: сколько строк старше обещанного политикой
 * (#3388, п. 2; слово владельца 16.11 «карт-бланш»).
 *
 * Политика (`app/legal/privacy/page.tsx`, «Сроки хранения») обещает пять
 * сроков, и до 16.11 код не исполнял ни одного. Прежде чем удалять, нужно
 * знать, что уже за сроком: перепись отдаёт только числа и дату самой старой
 * строки — без имён, телефонов и id. Только чтение.
 *
 * Отсчёт (решение 16.11): заявка — от последнего изменения (`updated_at`),
 * бронь — от даты тура, диалог — от последнего обмена репликами. Так данные
 * никогда не удаляются раньше обещанного.
 *
 * У профиля пользователя поля последней активности нет (ни `last_login_at`,
 * ни `last_seen` в схеме), и срок «3 года после последней активности»
 * посчитать нечем. Перепись так и говорит, а не берёт `updated_at` за
 * активность (§4.0).
 *
 * Таблица, которой нет в базе прода (42P01), — отдельный исход «нет
 * таблицы», а не ноль и не сбой: часть журналов baseline на проде могла не
 * создаваться.
 */

/** Какой срок политики проверяется. */
export type RetentionTerm = 'tech_logs_90d' | 'leads_3y' | 'bookings_5y' | 'chat_3y';

export interface RetentionTarget {
  table: string;
  /** Колонка отсчёта: время записи или дата тура. */
  column: string;
  term: RetentionTerm;
  days: number;
  /** Чистится ли таблица уже сейчас и чем — чтобы перепись не звала к уже сделанному. */
  pruned: string | null;
}

export const TECH_LOG_DAYS = 90;
export const LEAD_DAYS = 3 * 365;
export const BOOKING_DAYS = 5 * 365;
export const CHAT_DAYS = 3 * 365;

const log = (table: string, column = 'created_at', pruned: string | null = null): RetentionTarget =>
  ({ table, column, term: 'tech_logs_90d', days: TECH_LOG_DAYS, pruned });

/**
 * Список составлен по схеме (миграции и baseline) 16.11. Журналы, которые
 * уже чистятся по своему сроку, тоже здесь: перепись показывает, держится
 * ли срок на деле, а не только в коде.
 */
export const RETENTION_TARGETS: readonly RetentionTarget[] = [
  log('a2a_dialogs', 'created_at', '90 дней при записи (lib/a2a/dialog-log.ts)'),
  log('a2a_requests'),
  log('mcp_tool_calls'),
  log('mcp_clients', 'day'),
  log('mcp_write_attempts', 'created_at', '30 дней, при 2% записей (lib/mcp/write-guard.ts)'),
  log('mcp_handoff_events'),
  log('kuzmich_write_journal'),
  log('kuzmich_safety_reviews', 'created_at', '30 дней (lib/kuzmich/safety-review-log.ts)'),
  log('llm_usage_log'),
  log('ai_actions_log'),
  log('rag_quality_log'),
  log('query_expansion_log'),
  log('client_errors', 'created_at', '30 дней (client-errors-census ?prune=1)'),
  log('page_views'),
  log('funnel_events', 'created_at', '90 дней при разборе воронки (growth-agent)'),
  log('tour_selection_events'),
  log('agent_run_history'),
  log('agent_events'),
  log('audit_log'),
  log('audit_logs'),
  log('notification_log'),
  log('smart_notifications_log'),
  log('octo_webhook_log'),
  log('uon_sync_log'),
  { table: 'leads', column: 'updated_at', term: 'leads_3y', days: LEAD_DAYS, pruned: null },
  { table: 'operator_bookings', column: 'booking_date', term: 'bookings_5y', days: BOOKING_DAYS, pruned: null },
  { table: 'accommodation_bookings', column: 'check_out_date', term: 'bookings_5y', days: BOOKING_DAYS, pruned: null },
  { table: 'chat_sessions', column: 'updated_at', term: 'chat_3y', days: CHAT_DAYS, pruned: null },
];

/**
 * SQL одной строки переписи. Имя таблицы и колонки — из списка выше, не из
 * запроса; срок — параметром через make_interval (склейка интервала строкой
 * запрещена сторожем sql-interval-not-concatenated).
 */
export function retentionCountSql(t: Pick<RetentionTarget, 'table' | 'column'>): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(t.table) || !/^[a-z_][a-z0-9_]*$/.test(t.column)) {
    throw new Error(`retention-census: недопустимое имя ${t.table}.${t.column}`);
  }
  return `SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE ${t.column} < NOW() - make_interval(days => $1::int))::int AS over_term,
                 MIN(${t.column})::date::text AS oldest
            FROM ${t.table}`;
}

export type RetentionRow =
  | { table: string; column: string; term: RetentionTerm; days: number; pruned: string | null; state: 'ok'; total: number; over_term: number; oldest: string | null }
  | { table: string; column: string; term: RetentionTerm; days: number; pruned: string | null; state: 'no_table' }
  | { table: string; column: string; term: RetentionTerm; days: number; pruned: string | null; state: 'failed'; reason: string };

export interface RetentionCensus {
  rows: RetentionRow[];
  /** Сроки, которые посчитать нечем, — словами. */
  unmeasurable: string[];
  /** Сколько таблиц за сроком хоть одной строкой — по каждому сроку. */
  over_term_tables: Record<RetentionTerm, number>;
  failed: number;
}

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

export async function runRetentionCensus(query: Query, targets: readonly RetentionTarget[] = RETENTION_TARGETS): Promise<RetentionCensus> {
  const rows: RetentionRow[] = [];
  for (const t of targets) {
    const base = { table: t.table, column: t.column, term: t.term, days: t.days, pruned: t.pruned };
    try {
      const { rows: r } = await query(retentionCountSql(t), [t.days]);
      const one = r[0] ?? {};
      rows.push({
        ...base, state: 'ok',
        total: Number(one.total ?? 0),
        over_term: Number(one.over_term ?? 0),
        oldest: typeof one.oldest === 'string' ? one.oldest : null,
      });
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : 'нет SQLSTATE';
      if (code === '42P01') {
        rows.push({ ...base, state: 'no_table' });
        continue;
      }
      console.error('[retention-census] замер не удался', { table: t.table, sqlstate: code });
      rows.push({ ...base, state: 'failed', reason: `SQLSTATE ${code}` });
    }
  }
  const over: Record<RetentionTerm, number> = { tech_logs_90d: 0, leads_3y: 0, bookings_5y: 0, chat_3y: 0 };
  for (const r of rows) if (r.state === 'ok' && r.over_term > 0) over[r.term]++;
  return {
    rows,
    unmeasurable: [
      'Профиль: «3 года после последней активности» посчитать нечем — поля последней активности (вход, визит) в таблице users нет. updated_at меняется при любой правке строки и активностью не является.',
    ],
    over_term_tables: over,
    failed: rows.filter((r) => r.state === 'failed').length,
  };
}
