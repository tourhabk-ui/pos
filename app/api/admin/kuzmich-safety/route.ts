/**
 * GET /api/admin/kuzmich-safety — утверждения Кузьмича о безопасности для
 * разбора человеком (#2300). По умолчанию — неразобранные, сначала то, что
 * сторож пометил (вопреки данным, без опоры, без проверки), потом остальное.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { safeMsg } from '@/lib/errors/sanitize';

export const dynamic = 'force-dynamic';

interface ReviewRow {
  id: string; created_at: string; surface: string; verdict: string;
  claims: unknown; flagged: unknown; tools: string[]; reply_excerpt: string;
  review_mark: string | null; review_note: string | null; reviewed_at: string | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const all = request.nextUrl.searchParams.get('status') === 'all';
  try {
    const [rows, counts] = await Promise.all([
      query<ReviewRow>(
        `SELECT id::text, created_at, surface, verdict, claims, flagged, tools, reply_excerpt,
                review_mark, review_note, reviewed_at
           FROM kuzmich_safety_reviews
          WHERE ($1::boolean OR review_mark IS NULL)
          ORDER BY (verdict = 'contradicted') DESC, (verdict IN ('unbacked', 'unverifiable')) DESC, created_at DESC
          LIMIT 100`,
        [all],
      ),
      query<{ verdict: string; open: number; total: number }>(
        `SELECT verdict, COUNT(*) FILTER (WHERE review_mark IS NULL)::int AS open, COUNT(*)::int AS total
           FROM kuzmich_safety_reviews GROUP BY verdict`,
        [],
      ),
    ]);
    return NextResponse.json({ success: true, data: { items: rows.rows, counts: counts.rows } });
  } catch (error) {
    console.error('[admin/kuzmich-safety] список не прочитан', safeMsg(error));
    return NextResponse.json({ success: false, error: 'Список разбора не прочитался, попробуйте позже.' }, { status: 503 });
  }
}
