/**
 * GET /api/admin/agents/liveness — единая живость всех запланированных
 * cron-агентов. Реестр (cron-registry) × последняя строка agent_run_history по
 * agent_id → статус жив/опоздал/мёртв. Безопасность сортируется первой.
 * Требует роль admin.
 *
 * Честность: агенты без телеметрии (agentId === null) отдаются со статусом
 * 'unknown', а не выдуманным зелёным.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { CRON_REGISTRY, TIER_ORDER, TIER_LABELS, type CronTier } from '@/lib/agents/cron-registry';
import { computeLiveness, overallPosture, type LivenessStatus } from '@/lib/agents/cron-liveness';

export const dynamic = 'force-dynamic';

interface LastRow { agent_id: string; status: string; started_at: string }

interface LivenessItem {
  key: string;
  label: string;
  description: string;
  workflow: string;
  schedule: string;
  tier: CronTier;
  triggerable: boolean;
  instrumented: boolean;
  agent_id: string | null;
  last_run: string | null;
  last_status: string | null;
  liveness: LivenessStatus;
  minutes_since: number | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  // Последний запуск по каждому инструментированному agent_id
  const agentIds = Array.from(new Set(CRON_REGISTRY.map(e => e.agentId).filter((x): x is string => x !== null)));
  const lastByAgent = new Map<string, LastRow>();

  if (agentIds.length > 0) {
    try {
      const { rows } = await pool.query<LastRow>(
        `SELECT DISTINCT ON (agent_id) agent_id, status, started_at::text
           FROM agent_run_history
          WHERE agent_id = ANY($1)
          ORDER BY agent_id, started_at DESC`,
        [agentIds],
      );
      for (const r of rows) lastByAgent.set(r.agent_id, r);
    } catch (err) {
      return NextResponse.json(
        { success: false, error: err instanceof Error ? err.message : 'Ошибка БД' },
        { status: 500 },
      );
    }
  }

  const now = Date.now();
  const items: LivenessItem[] = CRON_REGISTRY.map(e => {
    const last = e.agentId ? lastByAgent.get(e.agentId) ?? null : null;
    const lastRunMs = last ? new Date(last.started_at).getTime() : null;
    const lv = computeLiveness(e, lastRunMs, now);
    return {
      key: e.key,
      label: e.label,
      description: e.description,
      workflow: e.workflow,
      schedule: e.schedule,
      tier: e.tier,
      triggerable: e.triggerable,
      instrumented: e.agentId !== null,
      agent_id: e.agentId,
      last_run: last?.started_at ?? null,
      last_status: last?.status ?? null,
      liveness: lv.status,
      minutes_since: lv.minutesSince,
    };
  });

  const posture = overallPosture(items.map(i => ({ tier: i.tier, status: i.liveness })));

  const groups = TIER_ORDER.map(tier => ({
    tier,
    label: TIER_LABELS[tier],
    items: items.filter(i => i.tier === tier),
  })).filter(g => g.items.length > 0);

  const counts = {
    total: items.length,
    instrumented: items.filter(i => i.instrumented).length,
    alive: items.filter(i => i.liveness === 'alive').length,
    late: items.filter(i => i.liveness === 'late').length,
    dead: items.filter(i => i.liveness === 'dead' || i.liveness === 'never').length,
    unknown: items.filter(i => i.liveness === 'unknown').length,
  };

  return NextResponse.json({ success: true, posture, counts, groups, generated_at: new Date().toISOString() });
}
