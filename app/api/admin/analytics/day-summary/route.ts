/**
 * GET /api/admin/analytics/day-summary — четыре числа суток для обзора
 * админки: люди, MCP, A2A, Кузьмич (слово владельца 22.10). Сегодня и вчера
 * по Камчатке. Правила счёта и исходы — lib/analytics/day-summary.
 *
 * Входных параметров нет: сутки задаёт часовой пояс Камчатки, а не клиент.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { readDaySummary } from '@/lib/analytics/day-summary';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  // Каждое число читается отдельно и отказывает отдельно (readDaySummary не
  // бросает): ответ 200 и при отказе одного запроса, с ошибкой в его поле.
  const data = await readDaySummary(new Date());
  return NextResponse.json({ success: true, data });
}
