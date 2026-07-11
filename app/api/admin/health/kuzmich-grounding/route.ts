/**
 * GET /api/admin/health/kuzmich-grounding
 *
 * Health-метрика заземления Кузьмича: сводка outcomes-грейдера за 7 дней —
 * сколько ответов оценено, средний балл, сколько с низким качеством и
 * сколько с незаземлёнными фактами (конкретика цен/телефонов/наличия без
 * вызова инструментов данных — правило CLAUDE.md §8: критичные факты
 * только из инструментов/БД).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getOutcomesSummary } from '@/lib/agents/managed/kuzmich-outcomes';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const summary = await getOutcomesSummary(7);
  return NextResponse.json({
    ...summary,
    ok: summary.total_graded === 0 || summary.ungrounded_count / summary.total_graded < 0.1,
  });
}
