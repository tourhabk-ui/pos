/**
 * GET /api/cron/routes-audit — диагностика качества маршрутов под Bearer
 * CRON_SECRET (не админ-сессия). Workflow дёргает её и печатает JSON в лог
 * GitHub Actions: агент видит цифры прода без прямого доступа к БД.
 *
 * Только читает. Логика — в lib/routes/audit.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { computeRoutesAudit } from '@/lib/routes/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const audit = await computeRoutesAudit();
    return NextResponse.json({ success: true, ...audit });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка аудита маршрутов';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
