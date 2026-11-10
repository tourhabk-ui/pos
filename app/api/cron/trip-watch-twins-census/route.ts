/**
 * GET /api/cron/trip-watch-twins-census — двойники контроля выхода с формы
 * `/register`. ТОЛЬКО ЧТЕНИЕ.
 *
 * Зачем. До 10.11 одна отправка формы создавала две записи контроля; «Я
 * вернулся» закрывал одну, вторая после срока поднимала тревогу контакту и
 * дежурному (docs/safety/MCHS_PLAN.md, С1). Дверь закрыта, но сколько пар уже
 * лежит в базе и сколько из них ещё может поднять ложную тревогу, из
 * репозитория не видно. Что делать с найденными — решает владелец.
 *
 * `?window=` — в скольких секундах после первой записи вторая считается
 * двойником (1…3600, по умолчанию 120).
 *
 * Наружу — только числа и два дня (первый и последний двойник). Имён,
 * телефонов и номеров записей нет: номер записи — ключ ссылки возвращения.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import {
  TRIP_WATCH_TWINS_SQL, twinWindowSeconds, twinsReportFromRow, twinsVerdict,
} from '@/lib/safety/trip-watch-twins';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const windowSeconds = twinWindowSeconds(request.nextUrl.searchParams.get('window'));
  if (windowSeconds === null) {
    return NextResponse.json({ ok: false, error: 'window — целое число секунд от 1 до 3600' }, { status: 400 });
  }

  try {
    const { rows } = await pool.query(TRIP_WATCH_TWINS_SQL, [windowSeconds, new Date()]);
    const report = twinsReportFromRow(rows[0] as Record<string, unknown> | undefined);
    if (!report) {
      // Третий исход: ответ базы не разобран — это не «двойников нет».
      console.error('[trip-watch-twins-census] ответ базы не разобран');
      return NextResponse.json({ ok: false, reason: 'ответ базы не разобран' }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      probe: 'trip_watch_twins_v1',
      collected_at: new Date().toISOString(),
      window_seconds: windowSeconds,
      verdict: twinsVerdict(report),
      ...report,
    });
  } catch (err) {
    // Не смог посчитать — это не «двойников нет».
    const e = err as { code?: string };
    console.error('[trip-watch-twins-census] перепись не выполнена:', { sqlstate: e?.code ?? 'нет SQLSTATE' });
    return NextResponse.json({ ok: false, reason: 'база не ответила', sqlstate: e?.code ?? null }, { status: 500 });
  }
}
