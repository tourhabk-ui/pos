/**
 * GET /api/cron/places-audit — та же диагностика качества мест, но под
 * Bearer CRON_SECRET (не админ-сессия). Нужна, чтобы workflow дёрнул её и
 * напечатал JSON в лог GitHub Actions: агент читает лог и видит реальные
 * цифры прода, не имея прямого доступа к БД (файрвол managed-PostgreSQL).
 *
 * Только читает. Логика — в lib/places/audit.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { computePlacesAudit } from '@/lib/places/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const audit = await computePlacesAudit();
    return NextResponse.json({ success: true, ...audit });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка аудита мест';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
