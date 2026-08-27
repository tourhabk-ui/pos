/**
 * POST /api/cron/volcano-merge-gate
 *
 * Volcano OS — merge-gate: единственный human gate (решение владельца
 * 27.08, части 3–4 задания). Workflow-будильник шлёт сюда события PR и
 * получасовой sweep; ВСЯ логика (readiness, label, sticky-карточка,
 * kernel-задача code.merge, Telegram c dedup по head_sha) — на проде,
 * своим GITHUB_TOKEN. Будильник прав на запись в репозиторий не имеет,
 * merge не делает никто, кроме человека.
 *
 * Тело: { pr_number?: number } — с номером оценивается один PR, без —
 * sweep всех открытых agent-PR + застрявших задач ядра.
 *
 * URL: https://vedarai.ru/api/cron/volcano-merge-gate?secret=<CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { logAgentRun } from '@/lib/agents/run-logger';
import { evaluatePr, sweepAgentPrs } from '@/lib/agents/volcano/merge-gate';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const BodySchema = z.object({
  pr_number: z.number().int().positive().optional(),
}).strict();

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json({ error: 'GITHUB_TOKEN не настроен — merge-gate работать не может' }, { status: 500 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Некорректное тело запроса', issues: parsed.error.issues }, { status: 400 });
  }

  const repo = `${process.env.GITHUB_OWNER ?? 'tourhabk-ui'}/${process.env.GITHUB_REPO ?? 'pos'}`;
  const startedAt = new Date();

  try {
    const outcomes = parsed.data.pr_number
      ? [await evaluatePr(repo, parsed.data.pr_number)]
      : await sweepAgentPrs(repo);

    const errors = outcomes.filter((o) => o.detail?.startsWith('ошибка оценки'));
    const status = errors.length === 0 ? 'completed' : 'partial';

    const runLogged = await logAgentRun({
      agent_id: 'merge_gate',
      status: status === 'completed' ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      items_processed: outcomes.length,
      errors_count: errors.length,
      metadata: { outcomes },
    });

    return NextResponse.json({
      success: status === 'completed',
      status,
      run_logged: runLogged,
      evaluated: outcomes.length,
      outcomes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const runLogged = await logAgentRun({
      agent_id: 'merge_gate',
      status: 'failed',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      errors_count: 1,
      error_msg: msg,
    });
    return NextResponse.json(
      { success: false, status: 'failed', run_logged: runLogged, error: msg },
      { status: 500 },
    );
  }
}
