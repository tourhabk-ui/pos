/**
 * GET /api/admin/kuzmich-outcomes?days=7 — плохие оценки Кузьмича случаями:
 * вопрос, ответ, слова судьи (#3179). Только администратор, только чтение.
 *
 * Свод для публичного issue (`/api/cron/kuzmich-bad-outcomes`) отдаёт одни
 * числа и id. Здесь — сами случаи, поэтому дверь одна: requireAdmin, и в лог
 * не пишется ничего из текста — только SQLSTATE.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import {
  BAD_OUTCOME_CASES_SQL, CASES_LIMIT, parseDays, parseOutcomeCase, type OutcomeCaseRow,
} from '@/lib/agents/managed/kuzmich-outcome-cases';

export const dynamic = 'force-dynamic';

const TOTAL_SQL = `SELECT COUNT(*)::int AS n FROM agent_knowledge
   WHERE type = 'outcome' AND agent_id = 'kuzmich'
     AND created_at > NOW() - ($1::int * INTERVAL '1 day')`;

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const days = parseDays(request.nextUrl.searchParams.get('days'));
  try {
    const [bad, total] = await Promise.all([
      // Берём на одну больше потолка: так видно, что список обрезан.
      pool.query<OutcomeCaseRow>(BAD_OUTCOME_CASES_SQL, [days, CASES_LIMIT + 1]),
      pool.query<{ n: number }>(TOTAL_SQL, [days]),
    ]);
    const truncated = bad.rows.length > CASES_LIMIT;
    const cases = bad.rows.slice(0, CASES_LIMIT).map(parseOutcomeCase);
    return NextResponse.json({
      success: true,
      data: {
        days,
        outcomes_total: total.rows[0]?.n ?? 0,
        cases,
        truncated,
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[admin/kuzmich-outcomes] список не прочитан', typeof code === 'string' ? `SQLSTATE=${code}` : 'без SQLSTATE');
    return NextResponse.json({ success: false, error: 'Оценки не прочитались, попробуйте позже.' }, { status: 503 });
  }
}
