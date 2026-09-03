/**
 * GET /api/cron/intelligence
 *
 * Automated intelligence monitoring — runs every 6 hours.
 * Scans 3 domains: AI/Tech, Travel Industry, Competitors.
 * Stores findings in agent_memory, sends critical to Telegram.
 *
 * URL: https://vedarai.ru/api/cron/intelligence?secret=<CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { runIntelligenceCycle } from '@/lib/services/intelligence-monitor.service';
import { timingSafeCompare } from '@/lib/security/timing-safe';
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

  try {
    const startedAt = new Date();
    const report = await runIntelligenceCycle();

    // Log to run history
    await logAgentRun({
      agent_id: 'intelligence',
      status: report.domains.length > 0 ? 'success' : 'partial',
      started_at: startedAt,
      duration_ms: report.duration_ms,
      items_processed: report.raw_count,
      items_created: report.domains.length,
      // Прежде здесь стоял жёсткий 0: цикл, у которого упали все домены,
      // отчитывался нулём ошибок.
      errors_count: report.errors_count,
      metadata: {
        // Общий ключ `skip_reason` — его читает Watchdog у ЛЮБОГО крона.
        // 23.08 тревога говорила «причина пропуска не записана», и это была
        // правда: причины не было ни здесь, ни в цикле.
        skip_reason: report.skip_reason,
        outcomes: report.outcomes,
        // Поимённо, а не классом (03.09). Сервис уже называл мёртвую ленту
        // (`empty_reasons`), а роут это отбрасывал: в историю доезжал только
        // `no_signals`, и «Разведка» четвёртые сутки числилась пустой без
        // единого имени того, что чинить. Код называет класс беды, чинят
        // конкретную ленту (§4.0).
        empty_reasons: report.empty_reasons,
        domains: report.domains.map(d => ({
          domain: d.domain,
          urgency: d.urgency,
          signals: d.signals.length,
        })),
      },
    });

    // Log to audit trail
    await pool.query(
      `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
      [
        'intelligence_cycle',
        JSON.stringify({
          decision: 'intelligence_monitoring',
          result: 'success',
          duration_ms: report.duration_ms,
          raw_signals: report.raw_count,
          findings: report.domains.length,
          domains: report.domains.map(d => ({
            domain: d.domain,
            urgency: d.urgency,
            signals: d.signals.length,
            actions: d.action_items.length,
          })),
        }),
      ]
    );

    return NextResponse.json({
      ok: true,
      timestamp: report.timestamp,
      raw_signals: report.raw_count,
      findings: report.domains.length,
      duration_ms: report.duration_ms,
      // Ответ читают из лога GitHub Actions — единственного места, куда
      // видно без админ-доступа. `raw_signals: 72, findings: 0, domains: []`
      // без причины читалось как «разведка мертва»; на деле 72 сигнала
      // дошли, модель честно сказала «не применимо», а у одного из доменов
      // ленты ответили пустотой. Причина и имена лент — в ответе.
      skip_reason: report.skip_reason,
      outcomes: report.outcomes,
      empty_reasons: report.empty_reasons,
      domains: report.domains.map(d => ({
        domain: d.domain,
        urgency: d.urgency,
        summary: d.summary,
        action_items: d.action_items,
      })),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await logAgentRun({
      agent_id: 'intelligence',
      status: 'failed',
      started_at: new Date(),
      duration_ms: 0,
      errors_count: 1,
      error_msg: errMsg,
    });
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
