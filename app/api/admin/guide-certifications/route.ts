import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { REGISTRY_CUTOFF } from '@/lib/guides/reattestation';
import { logGuideFailure } from '@/lib/guides/db-failure';
import { z } from 'zod';

/**
 * Проверка аттестатов гидов администратором.
 *
 * Состояние аттестата (миграция 1016):
 *   is_verified = true                         → подтверждён;
 *   is_verified = false, reviewed_at IS NULL   → ждёт проверки;
 *   is_verified = false, reviewed_at NOT NULL  → отклонён (review_comment).
 *
 * Прежний PATCH принимал любую строку как id, не проверял, что строка нашлась
 * (rowCount), а экран не смотрел на ответ — «подтвердил» мог значить «ничего
 * не произошло». Счётчики на экране стартовали с '0' до загрузки и оставались
 * нулями при отказе, а гиды без единой даты выдачи не попадали ни в одну
 * цифру — их переаттестацию платформа не могла оценить и молчала об этом.
 */

const VerifySchema = z.object({
  id: z.string().uuid('Некорректный идентификатор аттестата'),
  is_verified: z.boolean({ message: 'Поле is_verified обязательно' }),
  comment: z.string().trim().max(1000).optional(),
}).refine((v) => v.is_verified || (v.comment?.length ?? 0) >= 5, {
  message: 'Причина отказа обязательна (не короче 5 символов) — её увидит гид',
  path: ['comment'],
});

const FilterSchema = z.enum(['all', 'pending', 'rejected', 'true']).default('all');

export const dynamic = 'force-dynamic';

interface CertRow {
  id: string;
  guide_id: string;
  guide_name: string | null;
  guide_email: string | null;
  name: string;
  issuing_authority: string;
  issue_date: string | null;
  expiry_date: string | null;
  certificate_number: string | null;
  document_url: string | null;
  is_verified: boolean;
  source: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
}

interface StatsRow {
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  verified_unreviewed: number;
  expired: number;
}

// GET /api/admin/guide-certifications?filter=all|pending|rejected|true
export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const filterParsed = FilterSchema.safeParse(request.nextUrl.searchParams.get('filter') ?? undefined);
  if (!filterParsed.success) {
    return NextResponse.json({ success: false, error: 'Неизвестный фильтр' }, { status: 400 });
  }
  const filter = filterParsed.data;
  const where =
    filter === 'true' ? 'WHERE gc.is_verified = true'
    : filter === 'pending' ? 'WHERE gc.is_verified IS NOT TRUE AND gc.reviewed_at IS NULL'
    : filter === 'rejected' ? 'WHERE gc.is_verified IS NOT TRUE AND gc.reviewed_at IS NOT NULL'
    : '';

  try {
    const result = await query<CertRow>(
      `SELECT gc.id, gc.guide_id, gc.name, gc.issuing_authority,
              to_char(gc.issue_date, 'YYYY-MM-DD')  AS issue_date,
              to_char(gc.expiry_date, 'YYYY-MM-DD') AS expiry_date,
              gc.certificate_number, gc.document_url,
              COALESCE(gc.is_verified, false) AS is_verified,
              gc.source, gc.reviewed_at, gc.review_comment, gc.created_at,
              COALESCE(p.company_name, p.name) AS guide_name,
              u.email AS guide_email
       FROM guide_certifications gc
       JOIN partners p ON gc.guide_id = p.id
       LEFT JOIN users u ON p.user_id = u.id
       ${where}
       ORDER BY (gc.is_verified IS NOT TRUE AND gc.reviewed_at IS NULL) DESC, gc.updated_at DESC
       LIMIT 500`,
      [],
    );

    const statsResult = await query<StatsRow>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_verified = true)::int AS verified,
         COUNT(*) FILTER (WHERE is_verified IS NOT TRUE AND reviewed_at IS NULL)::int AS pending,
         COUNT(*) FILTER (WHERE is_verified IS NOT TRUE AND reviewed_at IS NOT NULL)::int AS rejected,
         COUNT(*) FILTER (WHERE is_verified = true AND reviewed_at IS NULL)::int AS verified_unreviewed,
         COUNT(*) FILTER (WHERE expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE)::int AS expired
       FROM guide_certifications`,
      [],
    );

    // Переаттестация по гидам (логика = lib/guides/reattestation.ts):
    //   needed  — есть датированные аттестаты, и все до порога реестра;
    //   unknown — аттестаты есть, но ни у одного нет даты выдачи: платформа
    //             судить не может, и это отдельная цифра, а не ноль в «needed».
    const reattestationResult = await query<{ needed: number; unknown: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE dated > 0 AND after_cutoff = 0)::int AS needed,
         COUNT(*) FILTER (WHERE dated = 0)::int                     AS unknown
       FROM (
         SELECT guide_id,
                COUNT(*) FILTER (WHERE issue_date IS NOT NULL)     AS dated,
                COUNT(*) FILTER (WHERE issue_date >= $1::date)     AS after_cutoff
         FROM guide_certifications
         -- отклонённый аттестат — не свидетельство (как в /api/guide/reattestation)
         WHERE NOT (is_verified IS NOT TRUE AND reviewed_at IS NOT NULL)
         GROUP BY guide_id
       ) g`,
      [REGISTRY_CUTOFF],
    );

    return NextResponse.json({
      success: true,
      data: {
        items: result.rows,
        stats: {
          ...statsResult.rows[0],
          reattestation_needed: reattestationResult.rows[0]?.needed ?? null,
          reattestation_unknown: reattestationResult.rows[0]?.unknown ?? null,
        },
      },
    });
  } catch (error) {
    logGuideFailure('GET /api/admin/guide-certifications', error);
    return NextResponse.json({ success: false, error: 'Не удалось загрузить аттестаты' }, { status: 500 });
  }
}

// PATCH /api/admin/guide-certifications — подтвердить или отклонить
export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = VerifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
  }
  const { id, is_verified, comment } = parsed.data;

  try {
    const result = await query(
      `UPDATE guide_certifications
          SET is_verified    = $1,
              reviewed_at    = NOW(),
              reviewed_by    = $3,
              review_comment = $4,
              updated_at     = NOW()
        WHERE id = $2`,
      [is_verified, id, auth.userId, is_verified ? null : (comment ?? null)],
    );
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ success: false, error: 'Аттестат не найден' }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: is_verified ? 'Аттестат подтверждён' : 'Аттестат отклонён' });
  } catch (error) {
    logGuideFailure('PATCH /api/admin/guide-certifications', error);
    return NextResponse.json({ success: false, error: 'Не удалось сохранить решение' }, { status: 500 });
  }
}
