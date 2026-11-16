/**
 * GET /api/cron/booking-integrity-census — нарушения целостности броней и
 * заявок в текущих данных (#3388 п.3, шаг 1). Bearer CRON_SECRET, только
 * чтение, только числа.
 *
 * Перед ограничениями в базе (число людей больше нуля, дата в допустимом
 * окне, отменённая бронь не возвращается, повтор того же человека на тот же
 * тур и дату) нужно знать, сколько строк их уже нарушают: VALIDATE на
 * нарушенном правиле остановит накат миграций. Правила и запросы —
 * lib/bookings/integrity-census.ts.
 *
 * Отказ любого замера — 500 с именем замера и SQLSTATE: «переписи нет» не
 * равно «нарушений нет» (§4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import {
  INTEGRITY_MEASURES,
  assembleIntegrityCensus,
  type IntegrityFailure,
  type IntegrityMeasure,
} from '@/lib/bookings/integrity-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function sqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  const settled = await Promise.allSettled(INTEGRITY_MEASURES.map(([, sql]) => pool.query(sql)));
  const failed: IntegrityFailure[] = [];
  const got: Partial<Record<IntegrityMeasure, Record<string, unknown>[]>> = {};
  settled.forEach((s, i) => {
    const measure = INTEGRITY_MEASURES[i][0];
    if (s.status === 'fulfilled') {
      got[measure] = s.value.rows as Record<string, unknown>[];
    } else {
      const sqlstate = sqlstateOf(s.reason);
      failed.push({ measure, sqlstate });
      console.error(
        `[booking-integrity-census] замер ${measure} не выполнился`,
        `sqlstate=${sqlstate ?? 'нет кода'}`,
        s.reason instanceof Error ? s.reason.message : s.reason,
      );
    }
  });

  const body = assembleIntegrityCensus(got, failed, new Date().toISOString());
  return NextResponse.json(body, { status: failed.length === 0 ? 200 : 500 });
}
