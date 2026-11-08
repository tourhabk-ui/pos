/**
 * lib/ai/model-spend.ts — расход из нашего `llm_usage_log`: по КАЖДОЙ модели,
 * по агентам («за что») и за сегодня против дневного лимита. Читает вкладка
 * «Деньги» страницы «Расходы AI» (/api/admin/health/ai-money).
 *
 * Провайдер отдаёт (если отдаёт) остаток на счёт, а не по моделям. Разрез по
 * моделям есть только у нас: `logLLMUsage` в providers.ts пишет каждую
 * ответившую модель строкой (`route` = id модели, токены, оценка цены).
 *
 * Цена — оценка (`estimated_cost_usd`), и она бывает NULL: модель вне
 * каталога цен (#1862, миграция 961). SUM(...) NULL пропускает молча, поэтому
 * рядом с суммой всегда идёт число строк с неизвестной ценой — «дёшево» и
 * «не посчитано» обязаны различаться.
 */

import { pool } from '@/lib/db-pool';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { spendIdOf } from '@/lib/agents/agents-value-census';
import { TOOLS_LOOP_AGENT_ID } from '@/lib/ai/provider-usage';

export interface ModelSpendWindow {
  calls: number;
  tokens: number;
  /** Сумма известных цен, USD; null — ни одной строки с ценой. */
  cost_usd: number | null;
  /** Строки, у которых цена неизвестна — они в cost_usd НЕ вошли. */
  unknown_cost_calls: number;
}

export interface ModelSpend {
  model: string;
  /** Догадка о провайдере по имени модели — только для группировки на экране. */
  provider_guess: string;
  d1: ModelSpendWindow;
  d7: ModelSpendWindow;
  d30: ModelSpendWindow;
}

/**
 * Провайдер по имени модели. Это ДОГАДКА для группировки, не факт из лога:
 * в `llm_usage_log` провайдера нет. Нераспознанное имя — 'unknown', не
 * «ближайший похожий».
 */
export function guessProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('/')) return 'openrouter';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('qwen') || m.startsWith('qwq')) return 'qwen';
  if (m.startsWith('grok')) return 'xai';
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('kimi') || m.startsWith('moonshot')) return 'kimi';
  if (m.startsWith('yandexgpt') || m.startsWith('gpt://')) return 'yandex';
  if (m.startsWith('glm')) return 'glm';
  if (m.startsWith('mimo')) return 'mimo';
  if (m.startsWith('minimax') || m.startsWith('abab')) return 'minimax';
  if (m.startsWith('mistral') || m.startsWith('open-mistral') || m.startsWith('codestral')) return 'mistral';
  if (m.startsWith('fugu')) return 'fugu';
  return 'unknown';
}

interface SpendRow {
  model: string;
  calls_1: number; tokens_1: number | null; cost_1: string | null; unknown_1: number;
  calls_7: number; tokens_7: number | null; cost_7: string | null; unknown_7: number;
  calls_30: number; tokens_30: number | null; cost_30: string | null; unknown_30: number;
}

function toWindow(calls: number, tokens: number | null, cost: string | null, unknown: number): ModelSpendWindow {
  const parsed = cost === null ? null : Number(cost);
  return {
    calls,
    tokens: tokens ?? 0,
    cost_usd: parsed !== null && Number.isFinite(parsed) ? parsed : null,
    unknown_cost_calls: unknown,
  };
}

/** Расход по моделям за 1 / 7 / 30 дней. Только чтение. */
export async function loadModelSpend(): Promise<ModelSpend[]> {
  const { rows } = await pool.query<SpendRow>(`
    SELECT
      route AS model,
      COUNT(*)            FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int  AS calls_1,
      SUM(total_tokens)   FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int  AS tokens_1,
      SUM(estimated_cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')   AS cost_1,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day' AND estimated_cost_usd IS NULL)::int AS unknown_1,
      COUNT(*)            FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS calls_7,
      SUM(total_tokens)   FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS tokens_7,
      SUM(estimated_cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS cost_7,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND estimated_cost_usd IS NULL)::int AS unknown_7,
      COUNT(*)::int                                                                  AS calls_30,
      SUM(total_tokens)::int                                                         AS tokens_30,
      SUM(estimated_cost_usd)                                                        AS cost_30,
      COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int                        AS unknown_30
    FROM llm_usage_log
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY route
    ORDER BY SUM(estimated_cost_usd) DESC NULLS LAST, SUM(total_tokens) DESC
  `);
  return rows.map((r) => ({
    model: r.model,
    provider_guess: guessProvider(r.model),
    d1:  toWindow(r.calls_1,  r.tokens_1,  r.cost_1,  r.unknown_1),
    d7:  toWindow(r.calls_7,  r.tokens_7,  r.cost_7,  r.unknown_7),
    d30: toWindow(r.calls_30, r.tokens_30, r.cost_30, r.unknown_30),
  }));
}

// ── «За что»: расход по агентам ──────────────────────────────────────────────

/**
 * Строка «за что» (владелец 07.11: «как смотреть расходы и за что»): кто
 * потратил, по книгам. `agent_id` пишет `logLLMUsage` — имя агента из
 * `runWithUsageTracking`, а у живого Кузьмича — `TOOLS_LOOP_AGENT_ID`.
 * NULL — вызов вне агента: он назван отдельно, а не растворён в чужих суммах.
 */
export interface AgentSpend {
  agent_id: string | null;
  /** Подпись на экране: имя из реестра кронов, «Кузьмич» словами или сам id. */
  label: string;
  d1: ModelSpendWindow;
  d7: ModelSpendWindow;
  d30: ModelSpendWindow;
}

/** Подпись строки «без агента» — один текст на экране и в тестах. */
export const UNOWNED_SPEND_LABEL = 'без подписи — вызов вне агента';

/**
 * «За что» словами владельца — только для тех, кто пишет расход в книги.
 * Реестр кронов подписан где по-английски («Evo Judge»), а «рук» на GitHub и
 * живого Кузьмича в нём нет вовсе: их id в книгах — `claude`, `ci-sweeper`,
 * `kuzmich`. Связку держит сторож tests/unit/ai-money-tab.test.tsx в обе
 * стороны: у каждого, кто подписывает расход (`AGENT_ID` рук в workflow,
 * `runWithUsageTracking`, строки для usage-sink), подпись есть здесь или в
 * реестре, а у каждой подписи здесь есть такой писатель. Журнал прогонов
 * (`logAgentRun`) расход не подписывает: агент из журнала попадает в книги
 * своей строкой, только когда его вызовы модели обёрнуты (эволюция и
 * разведка — с 07.11).
 */
export const SPEND_LABELS: Readonly<Record<string, string>> = {
  // Живой Кузьмич: сайт, Telegram, MAX, A2A и Кузьмич партнёра (lib/ai/provider-usage).
  [TOOLS_LOOP_AGENT_ID]: 'Кузьмич — живые разговоры',
  'kuzmich-eval': 'Кузьмич: еженедельная проверка честности ответов',
  'kuzmich-eval-live': 'Кузьмич: проверка честности на живых вопросах',
  'kuzmich-eval-commercial': 'Кузьмич: проверка ответов о турах',
  'kuzmich-redteam': 'Кузьмич: проверка на провокации',
  'kuzmich-grader': 'Кузьмич: оценка ответов после разговора',
  editor: 'Editor: описания маршрутов',
  'editor-runner': 'Editor на GitHub: описания маршрутов',
  scout: 'Scout: предложения из разведки',
  'scout-digest': 'Дайджест разведки',
  intelligence: 'Разведка: новости ИИ, туризма, конкурентов',
  evo: 'Эволюция: ночной цикл',
  'evo-judge': 'Эволюция: судья находок (на GitHub)',
  'evo-review': 'Эволюция: ревью кода (на GitHub)',
  // «Руки» — claude-code-action на GitHub (scripts/hands-usage.mjs, AGENT_ID в workflow).
  claude: 'Руки на GitHub: задачи из issues и PR',
  'issue-triage': 'Руки на GitHub: ежедневный разбор issues',
  'ci-sweeper': 'Руки на GitHub: починка красного CI',
  'security-review': 'Ревью безопасности PR (на GitHub)',
  'weekly-chronicle': 'Руки на GitHub: хроника недели',
  'ai-visibility-panel': 'Замер: видят ли нас ИИ-поиски',
  'west-knowledge-probe': 'Проба: знают ли западные модели о нас',
  // Разовые прогоны по маркеру на GitHub (scripts/*-runner.ts, usage-sink с 08.11).
  'os-audit': 'Аудит ОС и эволюции по маркеру (на GitHub)',
  'route-analysis': 'Разбор справочника маршрутов по маркеру (на GitHub)',
  'source-discovery': 'Подбор источников разведки по маркеру (на GitHub)',
};

/**
 * Как назвать агента на экране «за что»: словами выше, иначе имя из реестра
 * кронов (`spendIdOf`: agentId записи, иначе её ключ), иначе сам id. Незнакомый
 * id показывается как есть: выдумывать ему имя — врать о том, кто тратит.
 */
export function agentSpendLabel(agentId: string | null): string {
  if (agentId === null) return UNOWNED_SPEND_LABEL;
  // Свой ключ, а не унаследованный: «constructor» из книг не станет функцией.
  if (Object.prototype.hasOwnProperty.call(SPEND_LABELS, agentId)) return SPEND_LABELS[agentId];
  const entry = CRON_REGISTRY.find((e) => spendIdOf(e) === agentId);
  return entry ? entry.label : agentId;
}

export interface AgentSpendRow {
  agent_id: string | null;
  calls_1: number; tokens_1: string | null; cost_1: string | null; unknown_1: number;
  calls_7: number; tokens_7: string | null; cost_7: string | null; unknown_7: number;
  calls_30: number; tokens_30: string | null; cost_30: string | null; unknown_30: number;
}

const tokensOf = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * Расход по агентам за 1 / 7 / 30 дней, дороже — выше; без цены — в конце.
 * Токены — текстом: SUM по колонке даёт bigint, и `::int` упал бы на 2^31.
 * Экспорт — для проверки на схеме прода (tests/integration/leads-followup.pg).
 */
export const AGENT_SPEND_SQL = `
    SELECT
      agent_id,
      COUNT(*)            FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int  AS calls_1,
      SUM(total_tokens)   FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::text AS tokens_1,
      SUM(estimated_cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')   AS cost_1,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day' AND estimated_cost_usd IS NULL)::int AS unknown_1,
      COUNT(*)            FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS calls_7,
      SUM(total_tokens)   FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::text AS tokens_7,
      SUM(estimated_cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS cost_7,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND estimated_cost_usd IS NULL)::int AS unknown_7,
      COUNT(*)::int                                                                  AS calls_30,
      SUM(total_tokens)::text                                                        AS tokens_30,
      SUM(estimated_cost_usd)                                                        AS cost_30,
      COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int                        AS unknown_30
    FROM llm_usage_log
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY agent_id
    ORDER BY SUM(estimated_cost_usd) DESC NULLS LAST, COUNT(*) DESC
  `;

export function toAgentSpend(r: AgentSpendRow): AgentSpend {
  return {
    agent_id: r.agent_id,
    label: agentSpendLabel(r.agent_id),
    d1:  toWindow(r.calls_1,  tokensOf(r.tokens_1),  r.cost_1,  r.unknown_1),
    d7:  toWindow(r.calls_7,  tokensOf(r.tokens_7),  r.cost_7,  r.unknown_7),
    d30: toWindow(r.calls_30, tokensOf(r.tokens_30), r.cost_30, r.unknown_30),
  };
}

/** Расход по агентам за 1 / 7 / 30 дней, дороже — выше. Только чтение. */
export async function loadAgentSpend(): Promise<AgentSpend[]> {
  const { rows } = await pool.query<AgentSpendRow>(AGENT_SPEND_SQL);
  return rows.map(toAgentSpend);
}

// ── Сегодня против дневного лимита ───────────────────────────────────────────

/**
 * Траты «сегодня» — той же границей суток, что у крона тревоги о бюджете
 * (`/api/cron/llm-budget-check`: `created_at >= DATE_TRUNC('day', NOW())`):
 * экран и тревога обязаны говорить об одних сутках. Начало суток отдаётся
 * самим запросом (`since`) — экран называет его по Камчатке, а не угадывает
 * часовой пояс базы.
 */
export interface SpendToday {
  since: string;
  calls: number;
  /** Сумма по вызовам с ценой; вызовы без цены в неё не вошли. */
  cost_usd: number;
  unpriced_calls: number;
}

export interface SpendTodayRow {
  since: Date | string | null;
  calls: number;
  spent: string | null;
  unpriced: number;
}

export const SPEND_TODAY_SQL = `
    SELECT DATE_TRUNC('day', NOW())                                AS since,
           COUNT(*)::int                                           AS calls,
           COALESCE(SUM(estimated_cost_usd), 0)::text              AS spent,
           COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unpriced
      FROM llm_usage_log
     WHERE created_at >= DATE_TRUNC('day', NOW())
  `;

/** Строка запроса — в ответ экрану; начало суток не прочлось — пустая строка, а не «сейчас». */
export function toSpendToday(r: SpendTodayRow | undefined): SpendToday {
  const since = r?.since instanceof Date ? r.since : new Date(String(r?.since ?? ''));
  return {
    since: Number.isNaN(since.getTime()) ? '' : since.toISOString(),
    calls: Number(r?.calls ?? 0),
    cost_usd: Number(r?.spent ?? 0),
    unpriced_calls: Number(r?.unpriced ?? 0),
  };
}

export async function loadSpendToday(): Promise<SpendToday> {
  const { rows } = await pool.query<SpendTodayRow>(SPEND_TODAY_SQL);
  return toSpendToday(rows[0]);
}
