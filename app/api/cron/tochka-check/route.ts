/**
 * GET /api/cron/tochka-check — дошли ли переменные СБП до сервера.
 *
 * Заведена 30.08.2026: владелец добавил TOCHKA_* в Timeweb, и нужен был
 * способ убедиться в этом без риска для платежей. Прод недостижим из
 * песочницы разработчика — читает раннер GitHub, тем же мостом, что
 * ai-channel-check.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ни одного запроса в банк — даже в песочницу: `createSBPQR()`
 * выпускает НАСТОЯЩИЙ QR на стороне Точки, и делать это только ради «дошли
 * ли переменные» не нужно. Разбор формы — `lib/payments/tochka.ts:tochkaReadiness()`,
 * чисто локальный.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { tochkaReadiness } from '@/lib/payments/tochka';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET не задан' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const readiness = tochkaReadiness();

  const summary = readiness.ok
    ? `переменные заданы и правильной формы${readiness.sandbox ? ' — контур ПЕСОЧНИЦА (TOCHKA_BASE_URL содержит sandbox)' : ' — контур БОЕВОЙ'}`
    : readiness.reason === 'missing_env'
      ? `не заданы: ${readiness.missing.join(', ')}`
      : `заданы, но не той формы: ${readiness.bad.join(', ')}`;

  return NextResponse.json({
    success: true,
    probe: 'tochka_check_v1',
    ...readiness,
    summary,
  });
}
