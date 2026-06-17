/**
 * lib/agents/warmup.ts
 *
 * Shared warm-up module for cron agents.
 * Solves the cold-start problem: agents previously started with no context
 * and had to guess instead of reading real state.
 *
 * Two entry points:
 *   writeDailyBriefing() — called by Scout-Innovator at 08:00 UTC; writes
 *     a platform snapshot to agent_knowledge (slug='daily-briefing').
 *   readAgentBriefing(agentId) — called by each cron agent at startup;
 *     returns platform state + this agent's own run history.
 */

import { pool } from '@/lib/db-pool';
import { knowledgeBase } from '@/lib/agents/memory/agent-knowledge';
import { runRepoScan } from '@/lib/agents/repo-scanner';

export interface AgentBriefing {
  /** Counts from DB + agent health summary */
  platformSummary: string;
  /** Last 5 runs of THIS agent */
  recentRuns: string;
  /** Last run of EACH agent (already embedded in platformSummary) */
  systemRuns: string;
  /** Last 3 proposals from Scout-Innovator Brain */
  recentDecisions: string;
}

interface InvRow {
  places: string;
  routes: string;
  tours: string;
  partners: string;
  bookings_week: string;
  confirmed_week: string;
}

interface RunRow {
  agent_id: string;
  status: string;
  started_at: string;
  items_processed: number | null;
  error_msg: string | null;
}

interface HealthRow {
  memory_total: string;
  runs_24h: string;
  errors_24h: string;
}

interface OwnRunRow {
  status: string;
  started_at: string;
  items_processed: number | null;
  items_created: number | null;
  error_msg: string | null;
}

/**
 * Called by Scout-Innovator at 08:00 UTC before synthesizing proposals.
 * Writes slug='daily-briefing', type='briefing' to agent_knowledge.
 * Pass gitLog (last N commit messages) if available.
 */
export async function writeDailyBriefing(gitLog?: string): Promise<void> {
  try {
    const [invRows, runRows, healthRows, repoScan] = await Promise.all([
      pool.query<InvRow>(`
        SELECT
          (SELECT COUNT(*)::text FROM places WHERE is_visible = true) AS places,
          (SELECT COUNT(*)::text FROM kamchatka_routes) AS routes,
          (SELECT COUNT(*)::text FROM operator_tours WHERE is_active = true) AS tours,
          (SELECT COUNT(*)::text FROM partners WHERE is_active = true) AS partners,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::text AS bookings_week,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND booking_status = 'confirmed')::text AS confirmed_week
        FROM operator_bookings
      `),
      pool.query<RunRow>(`
        SELECT DISTINCT ON (agent_id) agent_id, status, started_at::text, items_processed, error_msg
        FROM agent_run_history
        ORDER BY agent_id, started_at DESC
      `),
      pool.query<HealthRow>(`
        SELECT
          (SELECT COUNT(*)::text FROM agent_memory) AS memory_total,
          (SELECT COUNT(*)::text FROM agent_run_history WHERE started_at > NOW() - INTERVAL '24h') AS runs_24h,
          (SELECT COUNT(*)::text FROM agent_run_history WHERE status = 'error' AND started_at > NOW() - INTERVAL '24h') AS errors_24h
      `),
      runRepoScan(gitLog).catch(() => null),
    ]);

    const inv = invRows.rows[0];
    const health = healthRows.rows[0];

    const platformSummary = inv
      ? `Мест: ${inv.places} | маршрутов: ${inv.routes} | активных туров: ${inv.tours} | партнёров: ${inv.partners}\nБронирований за 7д: ${inv.bookings_week} (${inv.confirmed_week} подтверждено)\nПамять: ${health?.memory_total ?? '?'} записей | Запусков 24ч: ${health?.runs_24h ?? '?'} (ошибок: ${health?.errors_24h ?? '?'})`
      : '';

    const agentStatuses = runRows.rows
      .map(r =>
        `${r.agent_id}: ${r.status} (${r.started_at?.slice(0, 16)})${r.error_msg ? ' ERR: ' + r.error_msg.slice(0, 60) : ''}`
      )
      .join('\n');

    const sections = [
      `Дата: ${new Date().toISOString().slice(0, 10)}`,
      '',
      '=== ПЛАТФОРМА ===',
      platformSummary,
      '',
      '=== СТАТУСЫ АГЕНТОВ ===',
      agentStatuses,
    ];
    if (gitLog) {
      sections.push('', '=== ПОСЛЕДНИЕ КОММИТЫ ===', gitLog.slice(0, 1500));
    }
    if (repoScan) {
      sections.push(
        '',
        '=== REPO STATE ===',
        `Production: ${repoScan.healthSummary.split('\n')[0]}`,
        `DB: ${repoScan.tablesScanned} таблиц`,
        `Repo: ${repoScan.filesFound} файлов | API routes: см. repo-scan/${new Date().toISOString().slice(0, 10)}`,
      );
    }

    await knowledgeBase.upsert({
      slug: 'daily-briefing',
      type: 'briefing',
      title: `Ежедневный брифинг ${new Date().toISOString().slice(0, 10)}`,
      compiled_truth: sections.join('\n'),
      metadata: { generated_at: new Date().toISOString() },
      agent_id: 'system',
    });
  } catch (err) {
    console.error('[warmup] writeDailyBriefing failed:', err);
  }
}

/**
 * Called by each cron agent at startup.
 * Returns structured briefing: platform state + this agent's own run history.
 */
export async function readAgentBriefing(agentId: string): Promise<AgentBriefing> {
  const today = new Date().toISOString().slice(0, 10);
  const [briefingPage, ownRunRows, decisionPages, repoScanPage] = await Promise.all([
    knowledgeBase.get('daily-briefing').catch(() => null),
    pool.query<OwnRunRow>(`
      SELECT status, started_at::text, items_processed, items_created, error_msg
      FROM agent_run_history
      WHERE agent_id = $1
      ORDER BY started_at DESC
      LIMIT 5
    `, [agentId]).catch(() => ({ rows: [] as OwnRunRow[] })),
    knowledgeBase.list({ type: 'decision', limit: 3 }).catch(() => []),
    knowledgeBase.get(`repo-scan/${today}`).catch(() => null),
  ]);

  const ownHistory = ownRunRows.rows.length
    ? ownRunRows.rows.map(r =>
        `${r.started_at?.slice(0, 16)} — ${r.status}` +
        (r.items_processed != null ? ` (обработано: ${r.items_processed})` : '') +
        (r.items_created != null ? ` (создано: ${r.items_created})` : '') +
        (r.error_msg ? ` ERR: ${r.error_msg.slice(0, 80)}` : '')
      ).join('\n')
    : 'Нет истории запусков';

  const recentDecisions = decisionPages.length
    ? decisionPages.map(p => `[${p.slug}] ${p.compiled_truth?.slice(0, 200)}`).join('\n\n---\n\n')
    : '';

  const repoStateSnippet = repoScanPage
    ? repoScanPage.compiled_truth.slice(0, 2000)
    : '';

  const platformSummary = [
    briefingPage?.compiled_truth ?? '',
    repoStateSnippet ? '\n\n=== REPO STATE (сегодня) ===\n' + repoStateSnippet : '',
  ].join('').trim();

  return {
    platformSummary,
    recentRuns: ownHistory,
    systemRuns: '',  // already embedded in platformSummary
    recentDecisions,
  };
}
