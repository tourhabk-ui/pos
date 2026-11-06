/**
 * Перепись пользы агентов: что каждый крон реестра сделал за окно (05.11).
 *
 * Владелец: «проведи аудит всех наших агентов, их много — нужно ли такое
 * количество? или не хватает?». Аудит по коду нашёл холостых (Enrich Routes,
 * Kuzmich Place Reviews на выключателе MODEL_WRITES_PLACE_TEXT) и дубли, но
 * решать «снять или оставить» по коду — догадка. Здесь — данные: журнал
 * прогонов agent_run_history по каждой записи реестра за N дней.
 *
 * Род записи — пять исходов, «не знаю» отдельно от «ноль» (§4.0):
 *   no_telemetry — у записи реестра нет agentId: журналу нечего сказать;
 *   silent       — прогонов в окне нет вовсе;
 *   unmeasured   — прогоны есть, но ни один не назвал число обработанного:
 *                  ноль здесь — «не меряли», а не «ничего не сделал»;
 *   idle         — прогоны меряли, и все дали ноль;
 *   productive   — хоть один прогон что-то обработал или создал.
 *
 * Расход модели — из книг (llm_usage_log, колонка agent_id), а не из журнала
 * (06.11): журнал называет деньги одного разведчика ($0,24 за месяц), а судья
 * и ревью эволюции считают флагманом на раннере и в журнал не пишут вовсе.
 * Книги видят каждый вызов; чей он — говорит agent_id. Строка без агента —
 * «расход без хозяина», и она названа отдельно, а не растворена.
 *
 * Только чтение, только числа и id агентов — ПД в журнале и книгах нет.
 * Сторож: tests/unit/agents-value-census.test.ts.
 */

import { pool } from '@/lib/db-pool';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';

export type AgentValueKind = 'no_telemetry' | 'silent' | 'unmeasured' | 'idle' | 'productive';

export interface AgentRunStats {
  agent_id: string;
  runs: number;
  ok: number;
  partial: number;
  failed: number;
  measured_runs: number;
  productive_runs: number;
  items_processed: number;
  items_created: number;
  llm_calls: number;
  cost_usd: number;
  last_run: string | null;
  last_productive: string | null;
}

/** Расход модели одного агента по книгам за окно. */
export interface AgentLlmSpend {
  calls: number;
  /** Сумма по строкам с ценой; null — ни у одной строки цены нет. */
  cost_usd: number | null;
  /** Вызовы без цены (модели нет в каталоге и в запасе): сумма их не видит. */
  unpriced_calls: number;
}

export interface AgentValueRow {
  key: string;
  label: string;
  tier: string;
  schedule: string;
  agent_id: string | null;
  kind: AgentValueKind;
  stats: AgentRunStats | null;
  /** Расход по книгам; null — вызовов модели от этого агента в окне нет. */
  llm: AgentLlmSpend | null;
}

/** Окно по умолчанию и потолок: месяц говорит о пользе, год — уже археология. */
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;

export const AGENT_RUNS_SQL = `
  SELECT agent_id,
         COUNT(*)::int                                              AS runs,
         COUNT(*) FILTER (WHERE status = 'success')::int            AS ok,
         COUNT(*) FILTER (WHERE status = 'partial')::int            AS partial,
         COUNT(*) FILTER (WHERE status = 'failed')::int             AS failed,
         COUNT(*) FILTER (WHERE items_processed IS NOT NULL
                             OR items_created IS NOT NULL)::int     AS measured_runs,
         COUNT(*) FILTER (WHERE COALESCE(items_processed, 0)
                              + COALESCE(items_created, 0) > 0)::int AS productive_runs,
         COALESCE(SUM(items_processed), 0)::bigint                  AS items_processed,
         COALESCE(SUM(items_created), 0)::bigint                    AS items_created,
         COALESCE(SUM(llm_calls), 0)::bigint                        AS llm_calls,
         COALESCE(SUM(estimated_cost_usd), 0)::numeric(14, 6)       AS cost_usd,
         MAX(started_at)                                            AS last_run,
         MAX(started_at) FILTER (WHERE COALESCE(items_processed, 0)
                                     + COALESCE(items_created, 0) > 0) AS last_productive
    FROM agent_run_history
   WHERE started_at > NOW() - make_interval(days => $1::int)
   GROUP BY agent_id`;

/**
 * Книги расхода по агентам за окно. agent_id NULL — одна строка «без хозяина».
 */
export const LLM_SPEND_SQL = `
  SELECT agent_id,
         COUNT(*)::int                                            AS calls,
         SUM(estimated_cost_usd)::numeric(14, 6)                  AS cost_usd,
         COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int  AS unpriced_calls
    FROM llm_usage_log
   WHERE created_at > NOW() - make_interval(days => $1::int)
   GROUP BY agent_id`;

/**
 * Книги по агенту И модели (06.11, владелец: «Делай»): какие модели остались
 * без цены (14,7 тыс. вызовов за 30 дней не оценены) и какой моделью тратит
 * каждый дорогой агент. `route` в llm_usage_log — это id модели (logLLMUsage).
 * Дни — число календарных дней с вызовами: «одна неделя» и «весь месяц» —
 * разные истории за одни деньги. Потолок строк — LLM_BY_MODEL_LIMIT,
 * самые частые первыми.
 *
 * v4 (06.11): токены пары — вход без кэша, выход, прочитано из кэша — и сколько
 * вызовов оценено верхней границей (кэш по полной цене входа, `cost_basis`
 * `*_cache_upper_bound`). По ним сумму пересчитывают по цене продавца, не
 * дожидаясь, пока книги перепишут: прошлое в книгах не пересчитывается.
 * Кэш не сообщён ни разу — `cache_read_tokens` null, а не ноль.
 */
export const LLM_BY_MODEL_LIMIT = 40;
export const LLM_SPEND_BY_MODEL_SQL = `
  SELECT agent_id,
         route                                                    AS model,
         COUNT(*)::int                                            AS calls,
         SUM(estimated_cost_usd)::numeric(14, 6)                  AS cost_usd,
         COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int  AS unpriced_calls,
         COUNT(DISTINCT (created_at AT TIME ZONE 'UTC')::date)::int AS days_active,
         MIN(created_at)                                          AS first_at,
         MAX(created_at)                                          AS last_at,
         SUM(prompt_tokens)::bigint                               AS prompt_tokens,
         SUM(completion_tokens)::bigint                           AS completion_tokens,
         SUM(cache_read_tokens)::bigint                           AS cache_read_tokens,
         COUNT(*) FILTER (WHERE cost_basis LIKE '%cache_upper_bound')::int AS upper_bound_calls
    FROM llm_usage_log
   WHERE created_at > NOW() - make_interval(days => $1::int)
   GROUP BY agent_id, route
   ORDER BY COUNT(*) DESC, route
   LIMIT ${LLM_BY_MODEL_LIMIT}`;

export interface AgentModelSpend extends AgentLlmSpend {
  agent_id: string | null;
  model: string;
  days_active: number;
  first_at: string | null;
  last_at: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  /** null — кэш не сообщён ни одной строкой пары (это не ноль, миграция 1285). */
  cache_read_tokens: number | null;
  upper_bound_calls: number;
}

interface RawModelSpendRow {
  agent_id: string | null;
  model: string;
  calls: number | string;
  cost_usd: string | number | null;
  unpriced_calls: number | string;
  days_active: number | string;
  first_at: Date | string | null;
  last_at: Date | string | null;
  prompt_tokens: number | string | null;
  completion_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  upper_bound_calls: number | string;
}

export function toModelSpend(r: RawModelSpendRow): AgentModelSpend {
  const at = (v: Date | string | null) => (v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
  return {
    agent_id: r.agent_id,
    model: r.model,
    calls: Number(r.calls),
    cost_usd: r.cost_usd === null ? null : Number(r.cost_usd),
    unpriced_calls: Number(r.unpriced_calls),
    days_active: Number(r.days_active),
    first_at: at(r.first_at),
    last_at: at(r.last_at),
    prompt_tokens: Number(r.prompt_tokens ?? 0),
    completion_tokens: Number(r.completion_tokens ?? 0),
    cache_read_tokens: r.cache_read_tokens === null ? null : Number(r.cache_read_tokens),
    upper_bound_calls: Number(r.upper_bound_calls),
  };
}

interface RawSpendRow {
  agent_id: string | null;
  calls: number | string;
  cost_usd: string | number | null;
  unpriced_calls: number | string;
}

export function toSpend(r: RawSpendRow): AgentLlmSpend {
  return {
    calls: Number(r.calls),
    cost_usd: r.cost_usd === null ? null : Number(r.cost_usd),
    unpriced_calls: Number(r.unpriced_calls),
  };
}

interface RawRow {
  agent_id: string;
  runs: number; ok: number; partial: number; failed: number;
  measured_runs: number; productive_runs: number;
  items_processed: string | number; items_created: string | number;
  llm_calls: string | number; cost_usd: string | number;
  last_run: Date | string | null; last_productive: Date | string | null;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString();

export function toStats(r: RawRow): AgentRunStats {
  return {
    agent_id: r.agent_id,
    runs: Number(r.runs), ok: Number(r.ok), partial: Number(r.partial), failed: Number(r.failed),
    measured_runs: Number(r.measured_runs), productive_runs: Number(r.productive_runs),
    items_processed: Number(r.items_processed), items_created: Number(r.items_created),
    llm_calls: Number(r.llm_calls), cost_usd: Number(r.cost_usd),
    last_run: iso(r.last_run), last_productive: iso(r.last_productive),
  };
}

/** Род записи по её статистике — чистая функция, без базы. */
export function classifyAgentValue(agentId: string | null, stats: AgentRunStats | null): AgentValueKind {
  if (!agentId) return 'no_telemetry';
  if (!stats || stats.runs === 0) return 'silent';
  if (stats.productive_runs > 0) return 'productive';
  if (stats.measured_runs === 0) return 'unmeasured';
  return 'idle';
}

/**
 * Имя, под которым агент подписывает расход в книгах: agentId журнала, а у
 * записи без журнала — ключ реестра (судья и ревью эволюции подписываются
 * ключом, runWithUsageTracking в своих скриптах).
 */
export function spendIdOf(e: { key: string; agentId: string | null }): string {
  return e.agentId ?? e.key;
}

/** Сводит журнал и книги с реестром: каждая запись реестра — одна строка, порядок реестра. */
export function joinWithRegistry(
  statsById: ReadonlyMap<string, AgentRunStats>,
  spendById: ReadonlyMap<string, AgentLlmSpend> = new Map(),
): AgentValueRow[] {
  return CRON_REGISTRY.map((e) => {
    const agentId = e.agentId ?? null;
    const stats = agentId ? statsById.get(agentId) ?? null : null;
    return {
      key: e.key, label: e.label, tier: e.tier, schedule: e.schedule,
      agent_id: agentId, kind: classifyAgentValue(agentId, stats), stats,
      llm: spendById.get(spendIdOf(e)) ?? null,
    };
  });
}

export interface AgentsValueCensus {
  items: AgentValueRow[];
  /** Расход строк без агента: вызов был, чей — книги не знают. null — таких нет. */
  llm_unattributed: AgentLlmSpend | null;
  /** Расход агентов, которых нет в реестре кронов (Кузьмич, оценщики и т.п.). */
  llm_outside_registry: Array<{ agent_id: string } & AgentLlmSpend>;
  /** Книги по агенту и модели, самые частые первыми, не больше LLM_BY_MODEL_LIMIT. */
  llm_by_agent_model: AgentModelSpend[];
}

/** Делит книги на реестр, «без хозяина» и «вне реестра» — чистая функция. */
export function splitSpend(
  spendRows: ReadonlyArray<{ agent_id: string | null } & AgentLlmSpend>,
): { byId: Map<string, AgentLlmSpend>; unattributed: AgentLlmSpend | null; outside: Array<{ agent_id: string } & AgentLlmSpend> } {
  const known = new Set(CRON_REGISTRY.map(spendIdOf));
  const byId = new Map<string, AgentLlmSpend>();
  let unattributed: AgentLlmSpend | null = null;
  const outside: Array<{ agent_id: string } & AgentLlmSpend> = [];
  for (const r of spendRows) {
    const spend = { calls: r.calls, cost_usd: r.cost_usd, unpriced_calls: r.unpriced_calls };
    if (r.agent_id === null) unattributed = spend;
    else if (known.has(r.agent_id)) byId.set(r.agent_id, spend);
    else outside.push({ agent_id: r.agent_id, ...spend });
  }
  outside.sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0) || a.agent_id.localeCompare(b.agent_id));
  return { byId, unattributed, outside };
}

export async function readAgentsValueCensus(days: number): Promise<AgentsValueCensus> {
  const [runs, spend, byModel] = await Promise.all([
    pool.query<RawRow>(AGENT_RUNS_SQL, [days]),
    pool.query<RawSpendRow>(LLM_SPEND_SQL, [days]),
    pool.query<RawModelSpendRow>(LLM_SPEND_BY_MODEL_SQL, [days]),
  ]);
  const split = splitSpend(spend.rows.map((r) => ({ agent_id: r.agent_id, ...toSpend(r) })));
  return {
    items: joinWithRegistry(new Map(runs.rows.map((r) => [r.agent_id, toStats(r)])), split.byId),
    llm_unattributed: split.unattributed,
    llm_outside_registry: split.outside,
    llm_by_agent_model: byModel.rows.map(toModelSpend),
  };
}
