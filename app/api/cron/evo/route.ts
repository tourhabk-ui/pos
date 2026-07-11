/**
 * GET /api/cron/evo
 *
 * Evo System — параллельная оркестрация агентов.
 * Growth + Rescue + Evolver Analysis запускаются одновременно.
 * Evolution Loop — последовательно (пишет фиксы в БД).
 *
 * URL: https://vedarai.ru/api/cron/evo?secret=<CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runEvoOrchestrator } from '@/lib/agents/orchestrator';
import { buildEvoAlert } from '@/lib/agents/evo/alert';
import { logAgentRun } from '@/lib/agents/run-logger';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const scanType = request.nextUrl.searchParams.get('type') ?? 'full';
  const startedAt = new Date();

  try {
    const result = await runEvoOrchestrator(scanType);

    void logAgentRun({
      agent_id: 'evo',
      status: result.errors.length === 0 ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: result.duration_ms,
      metadata: result as unknown as Record<string, unknown>,
    });

    const alertText = buildEvoAlert(result);
    if (alertText) {
      void tgNotify(alertText);
    }

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    void logAgentRun({
      agent_id: 'evo',
      status: 'failed',
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      errors_count: 1,
      error_msg: err instanceof Error ? err.message : String(err),
    });

    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

async function tgNotify(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch { /* silent */ }
}
