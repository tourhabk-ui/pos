/**
 * Уборка технических журналов по сроку хранения (#3388, п. 2, шаг 2; слово
 * владельца 16.11 «карт-бланш»).
 *
 * Политика (`app/legal/privacy/page.tsx`, «Сроки хранения») обещает хранить
 * технические логи 90 дней, а код этого не исполнял. Здесь — исполнитель.
 * Счёт «что за сроком» — перепись `lib/legal/retention-census.ts`; срок тот
 * же (`TECH_LOG_DAYS`).
 *
 * Два действия, и выбор между ними — по тому, кто читает строку:
 *  - `delete` — строка целиком про человека (его вопрос, IP, браузер), а
 *    читателям она нужна не дольше 30 дней;
 *  - `anonymize` — строку читают отчёты «за всё время» или по диапазону дат
 *    (кто выдал права администратора, расход ИИ, счёт вызовов MCP и A2A).
 *    Стираются только поля о человеке: IP, браузер, хэш вызывающего,
 *    аргумент вызова, ссылка на пользователя. Колонка без NULL получает
 *    метку `ERASED_MARK`.
 *
 * Журналы, которых здесь нет, названы в `PURGE_SKIPPED` с причиной.
 *
 * Сухой прогон по умолчанию: без `apply` только считается, сколько строк
 * попало бы под действие, — ничего не пишется. С `apply` — пачками по
 * `PURGE_BATCH` строк, не больше `PURGE_MAX_BATCHES` пачек на таблицу за
 * прогон; не успели — `more: true`, остаток уберёт следующий прогон. Каждое
 * действие с `apply` пишется в журнал `retention_purge_log` (миграция 1451):
 * таблица, действие, сколько строк, исход. Имён, текстов и id строк в нём нет.
 *
 * Сроки заявок (3 года), броней (5 лет) и диалогов (3 года) ещё не наступили:
 * платформе меньше года, и перепись это показывает. Их уборка — отдельный
 * шаг, когда первые строки подойдут к сроку.
 */

import { TECH_LOG_DAYS } from '@/lib/legal/retention-census';

/** Метка вместо значения в колонке, где NULL запрещён схемой. */
export const ERASED_MARK = 'erased';

export const PURGE_BATCH = 5000;
export const PURGE_MAX_BATCHES = 20;

export type PurgeAction =
  | { kind: 'delete' }
  /** `nullable` — обнулить; `notNull` — колонка без NULL, ставится `ERASED_MARK`. */
  | { kind: 'anonymize'; nullable: readonly string[]; notNull?: readonly string[] };

export interface PurgeStep {
  table: string;
  /** Колонка отсчёта срока. */
  column: string;
  days: number;
  action: PurgeAction;
  /** Почему это действие, словами. */
  why: string;
}

const del = (table: string, why: string, column = 'created_at'): PurgeStep =>
  ({ table, column, days: TECH_LOG_DAYS, action: { kind: 'delete' }, why });

const anon = (table: string, nullable: readonly string[], why: string, notNull: readonly string[] = []): PurgeStep =>
  ({ table, column: 'created_at', days: TECH_LOG_DAYS, action: { kind: 'anonymize', nullable, notNull }, why });

/**
 * Разметка по чтению кода 16.11: кто пишет таблицу, какие колонки о человеке,
 * кому строки нужны дольше 90 дней.
 */
export const PURGE_STEPS: readonly PurgeStep[] = [
  del('a2a_dialogs', 'вопросы и ответы людей, IP и браузер; запись и так чистит старше 90 дней'),
  anon('a2a_requests', ['context_key'], 'счёт «за всё время» и дата начала журнала читают строки без окна; стирается ключ диалога и хэш вызывающего', ['caller_hash']),
  anon('mcp_tool_calls', ['caller_hash', 'arg_value'], 'перепись MCP называет даты «с какого дня» по всему журналу; стирается хэш вызывающего и аргумент вызова'),
  del('mcp_clients', 'имя программы и хэш вызывающего по дням; читатели берут не больше 90 дней', 'day'),
  anon('page_views', ['visitor_hash', 'session_id', 'ip_hash', 'referrer'], 'история посещаемости по страницам остаётся; стираются хэши посетителя, сессии, IP и адрес, откуда пришёл'),
  del('client_errors', 'текст ошибки из браузера мог содержать слова человека; перепись и так чистит старше 30 дней'),
  anon('audit_log', ['ip_address', 'user_agent'], 'строка — доказательство, кто и когда выдал права (admin-owners-census); стирается только IP и браузер'),
  anon('audit_logs', ['ip_address', 'user_agent'], 'журнал действий администратора читается без окна; стирается только IP и браузер'),
  anon('llm_usage_log', ['user_id'], 'расход ИИ смотрят по произвольному диапазону дат; стирается только ссылка на пользователя'),
  del('ai_actions_log', 'в metadata бывает отзыв туриста словами; читатели берут не больше 30 дней'),
  del('rag_quality_log', 'текст вопроса и ответа; читатели берут 7 дней'),
  del('query_expansion_log', 'текст запроса человека; читатели берут 7 дней'),
  anon('tour_selection_events', ['visitor_ip', 'user_agent'], 'воронку подборки смотрят окном до 90 дней; стираются IP и браузер'),
  del('smart_notifications_log', 'ссылка на пользователя; читатель берёт 24 часа'),
  del('octo_webhook_log', 'тело вебхука может нести данные брони; читателей нет'),
  del('kuzmich_safety_reviews', 'отрывок ответа мог повторять слова человека; запись и так чистит старше 30 дней'),
  del('mcp_write_attempts', 'хэши телефона и клиента; запись и так чистит старше 30 дней'),
  del('funnel_events', 'хэш посетителя; разбор воронки и так чистит старше 90 дней'),
];

/** Журналы переписи, которые уборка не трогает, — с причиной. */
export const PURGE_SKIPPED: Record<string, string> = {
  kuzmich_write_journal: 'журнал только на дописывание (триггер 1373): удаление запрещено базой; данных людей — ссылка на сессию',
  agent_events: 'журнал только на дописывание (триггер 917); данных людей в коде записи не найдено',
  agent_run_history: 'данных людей нет; сторож живости читает последнюю отметку агента без нижней границы',
  uon_sync_log: 'данных людей нет',
  mcp_handoff_events: 'данных людей нет',
  notification_log: 'писателя в коде нет, содержимое metadata неизвестно — разбирать отдельно',
};

const NAME = /^[a-z_][a-z0-9_]*$/;

function checkNames(step: PurgeStep): void {
  const cols = step.action.kind === 'anonymize' ? [...step.action.nullable, ...(step.action.notNull ?? [])] : [];
  for (const n of [step.table, step.column, ...cols]) {
    if (!NAME.test(n)) throw new Error(`retention-purge: недопустимое имя ${n}`);
  }
}

/** Условие «за сроком и ещё не убрано». $1 — дни. */
function staleWhere(step: PurgeStep): string {
  const age = `${step.column} < NOW() - make_interval(days => $1::int)`;
  if (step.action.kind === 'delete') return age;
  const left = [
    ...step.action.nullable.map((c) => `${c} IS NOT NULL`),
    ...(step.action.notNull ?? []).map((c) => `${c} <> '${ERASED_MARK}'`),
  ];
  return `${age} AND (${left.join(' OR ')})`;
}

/** Сколько строк попало бы под действие — сухой прогон. $1 — дни. */
export function purgeCountSql(step: PurgeStep): string {
  checkNames(step);
  return `SELECT COUNT(*)::int AS n FROM ${step.table} WHERE ${staleWhere(step)}`;
}

/** Одна пачка действия. $1 — дни, $2 — размер пачки. */
export function purgeBatchSql(step: PurgeStep): string {
  checkNames(step);
  const pick = `ctid = ANY(ARRAY(SELECT ctid FROM ${step.table} WHERE ${staleWhere(step)} LIMIT $2::int))`;
  if (step.action.kind === 'delete') return `DELETE FROM ${step.table} WHERE ${pick}`;
  const sets = [
    ...step.action.nullable.map((c) => `${c} = NULL`),
    ...(step.action.notNull ?? []).map((c) => `${c} = '${ERASED_MARK}'`),
  ];
  return `UPDATE ${step.table} SET ${sets.join(', ')} WHERE ${pick}`;
}

export type PurgeRow =
  | { table: string; action: PurgeAction['kind']; state: 'ok'; rows: number; more: boolean }
  | { table: string; action: PurgeAction['kind']; state: 'no_table' }
  | { table: string; action: PurgeAction['kind']; state: 'failed'; reason: string };

export interface PurgeRun {
  apply: boolean;
  rows: PurgeRow[];
  /** Всего строк: в сухом прогоне — попало бы, с apply — убрано. */
  total: number;
  failed: number;
  skipped: Record<string, string>;
}

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;

const sqlstateOf = (err: unknown): string =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : 'нет SQLSTATE';

export const PURGE_LOG_SQL = `INSERT INTO retention_purge_log (table_name, action, rows_affected, state, sqlstate)
  VALUES ($1, $2, $3, $4, $5)`;

export async function runRetentionPurge(
  query: Query,
  opts: { apply: boolean; steps?: readonly PurgeStep[]; batch?: number; maxBatches?: number },
): Promise<PurgeRun> {
  const steps = opts.steps ?? PURGE_STEPS;
  const batch = opts.batch ?? PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? PURGE_MAX_BATCHES;
  const rows: PurgeRow[] = [];
  for (const s of steps) {
    const base = { table: s.table, action: s.action.kind };
    try {
      if (!opts.apply) {
        const { rows: r } = await query(purgeCountSql(s), [s.days]);
        rows.push({ ...base, state: 'ok', rows: Number(r[0]?.n ?? 0), more: false });
        continue;
      }
      let done = 0;
      let more = false;
      for (let i = 0; i < maxBatches; i++) {
        const res = await query(purgeBatchSql(s), [s.days, batch]);
        const n = Number(res.rowCount ?? 0);
        done += n;
        if (n < batch) break;
        if (i === maxBatches - 1) more = true;
      }
      rows.push({ ...base, state: 'ok', rows: done, more });
      await logStep(query, s, done, 'ok', null);
    } catch (err) {
      const code = sqlstateOf(err);
      if (code === '42P01') {
        rows.push({ ...base, state: 'no_table' });
        continue;
      }
      // Имя таблицы и SQLSTATE — без текста запроса и значений (§4.0, pd-guard).
      console.error('[retention-purge] уборка не удалась', { table: s.table, sqlstate: code });
      rows.push({ ...base, state: 'failed', reason: `SQLSTATE ${code}` });
      if (opts.apply) await logStep(query, s, 0, 'failed', code);
    }
  }
  return {
    apply: opts.apply,
    rows,
    total: rows.reduce((sum, r) => sum + (r.state === 'ok' ? r.rows : 0), 0),
    failed: rows.filter((r) => r.state === 'failed').length,
    skipped: PURGE_SKIPPED,
  };
}

/** Строка журнала уборки. Отказ записи журнала не глушится, но и уборку не роняет. */
async function logStep(query: Query, s: PurgeStep, n: number, state: 'ok' | 'failed', sqlstate: string | null): Promise<void> {
  try {
    await query(PURGE_LOG_SQL, [s.table, s.action.kind, n, state, sqlstate]);
  } catch (err) {
    console.error('[retention-purge] журнал уборки не записан', { table: s.table, sqlstate: sqlstateOf(err) });
  }
}
