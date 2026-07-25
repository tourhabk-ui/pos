import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import {
  reattestationStatus,
  deadlinePassed,
  REATTESTATION_DEADLINE,
} from '@/lib/guides/reattestation';

export const dynamic = 'force-dynamic';

/**
 * GET /api/guide/reattestation
 * Статус переаттестации текущего гида (см. lib/guides/reattestation.ts).
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['guide', 'admin']);
  if (auth instanceof NextResponse) return auth;

  try {
    const guideId = await getGuidePartnerId(auth.userId);

    // to_char вместо сырой колонки: pg отдаёт DATE как JS Date, а расчёт
    // сравнивает ISO-строки лексикографически.
    const certs = guideId
      ? (
          await query<{ issue_date: string | null }>(
            `SELECT to_char(issue_date, 'YYYY-MM-DD') as issue_date
             FROM guide_certifications
             WHERE guide_id = $1`,
            [guideId]
          )
        ).rows
      : [];

    const today = new Date().toISOString().slice(0, 10);

    return NextResponse.json({
      success: true,
      data: {
        status: reattestationStatus(certs),
        deadline: REATTESTATION_DEADLINE,
        deadline_passed: deadlinePassed(today),
      },
    } as ApiResponse<unknown>);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка проверки статуса переаттестации' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
