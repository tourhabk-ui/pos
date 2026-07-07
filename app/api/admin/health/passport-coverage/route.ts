/**
 * GET /api/admin/health/passport-coverage — доля маршрутов с официальным
 * паспортом visitkamchatka.ru (задача K, паттерн air-quality-coverage).
 *
 * Официальный паспорт — сильнейший сигнал верифицированности маршрута
 * (три ведомства). Метрика делает покрытие видимым: после каждого прогона
 * импорта видно, сколько маршрутов подтверждено и какие категории пустые.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const result = await query<{
      total: string;
      with_passport: string;
    }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE official_passport_url IS NOT NULL) AS with_passport
       FROM kamchatka_routes`
    );

    const byCategory = await query<{ category: string; total: string; with_passport: string }>(
      `SELECT category,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE official_passport_url IS NOT NULL) AS with_passport
       FROM kamchatka_routes
       WHERE category IS NOT NULL
       GROUP BY category
       ORDER BY category`
    );

    const total = Number(result.rows[0]?.total ?? 0);
    const withPassport = Number(result.rows[0]?.with_passport ?? 0);
    const coveragePct = total > 0 ? Math.round((withPassport / total) * 1000) / 10 : 0;

    return NextResponse.json({
      status: withPassport > 0 ? 'ok' : 'degraded',
      reason: withPassport === 0 ? 'Ни один маршрут не привязан к официальному паспорту — импорт ещё не прогонялся' : undefined,
      total_routes: total,
      routes_with_passport: withPassport,
      coverage_pct: coveragePct,
      by_category: byCategory.rows.map(r => ({
        category: r.category,
        total: Number(r.total),
        with_passport: Number(r.with_passport),
      })),
      empty_categories: byCategory.rows
        .filter(r => Number(r.with_passport) === 0)
        .map(r => r.category),
    });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', error: 'Ошибка расчёта покрытия паспортами' },
      { status: 500 }
    );
  }
}
