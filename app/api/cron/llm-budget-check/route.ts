/**
 * GET /api/cron/llm-budget-check
 * Считает дневные LLM-затраты из llm_usage_log.
 * Если сумма превышает AI_DAILY_BUDGET_USD — отправляет Telegram-алерт владельцу.
 * Запускать ежечасно или реже.
 */

import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { notifyBudgetAlert } from '@/lib/telegram/admin-notify';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limitUsd = parseFloat(process.env.AI_DAILY_BUDGET_USD ?? '0');
  if (!limitUsd) {
    return Response.json({ ok: true, status: 'skipped', reason: 'AI_DAILY_BUDGET_USD not set' });
  }

  const { rows } = await pool.query<{ spent: string }>(`
    SELECT COALESCE(SUM(estimated_cost_usd), 0)::text AS spent
    FROM llm_usage_log
    WHERE created_at >= DATE_TRUNC('day', NOW())
  `);

  const spentUsd = parseFloat(rows[0]?.spent ?? '0');

  if (spentUsd >= limitUsd) {
    notifyBudgetAlert(spentUsd, limitUsd);
    return Response.json({
      ok: true,
      status: 'alert_sent',
      spent_usd: spentUsd,
      limit_usd: limitUsd,
    });
  }

  return Response.json({
    ok: true,
    status: 'ok',
    spent_usd: spentUsd,
    limit_usd: limitUsd,
  });
}
