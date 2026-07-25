/**
 * GET /api/cron/eco-expire?secret=<CRON_SECRET>
 *
 * Сгорание эко по сроку. Раньше «сгорание» происходило само собой из-за
 * фильтра expires_at в запросе баланса: эко переставали учитываться, в
 * журнале не оставалось следа, пользователю ничего не показывалось. Теперь
 * это обычная проводка со счёта держателя на счёт сжигания — видимая в
 * истории и участвующая в инварианте.
 *
 * Идемпотентен в пределах суток: ключ проводки — счёт плюс дата.
 * Расписание: .github/workflows/cron-eco-expire.yml (ежедневно 02:00 UTC).
 */

import { NextRequest, NextResponse } from 'next/server';
import { runEcoExpiry } from '@/lib/eco/expiry';
import { checkInvariant } from '@/lib/eco/ledger';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  try {
    const result = await runEcoExpiry();
    // Сжигание меняет балансы — сразу сверяем, что количество сохранилось.
    const invariant = await checkInvariant();

    recordCronRun('eco-expire', started, invariant.ok ? 'success' : 'failed', {
      items: result.expired,
    });

    return NextResponse.json({
      ok: invariant.ok,
      timestamp: new Date().toISOString(),
      ...result,
      invariant,
    });
  } catch (err) {
    recordCronRun('eco-expire', started, 'failed', { items: 0 });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Ошибка сгорания эко' },
      { status: 500 },
    );
  }
}
