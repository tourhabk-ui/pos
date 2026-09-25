import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { logGuideFailure } from '@/lib/guides/db-failure';
import {
  CertificationInputSchema, GUIDE_CERT_COLUMNS, toGuideCert, type GuideCertRow,
} from '@/lib/guides/certification-input';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/guide/certifications — аттестаты текущего гида и их проверка.
 * POST /api/guide/certifications — гид вносит аттестат сам.
 *
 * Внесённое гидом НЕ подтверждено: is_verified = false, reviewed_at = NULL —
 * «ждёт проверки», пока администратор не решит в
 * /hub/admin/guide-certifications. Бейдж «аттестован» на витрине читает
 * только подтверждённые (is_verified = true).
 */

async function resolveGuide(request: NextRequest): Promise<{ guideId: string } | NextResponse> {
  const auth = await requireRole(request, ['guide', 'admin']);
  if (auth instanceof NextResponse) return auth;
  const guideId = await getGuidePartnerId(auth.userId);
  if (!guideId) {
    return NextResponse.json(
      { success: false, error: 'Профиль гида не найден' } as ApiResponse<null>,
      { status: 404 },
    );
  }
  return { guideId };
}

export async function GET(request: NextRequest) {
  const resolved = await resolveGuide(request);
  if (resolved instanceof NextResponse) return resolved;

  try {
    const { rows } = await query<GuideCertRow>(
      `SELECT ${GUIDE_CERT_COLUMNS}
       FROM guide_certifications
       WHERE guide_id = $1
       ORDER BY issue_date DESC NULLS LAST, created_at DESC`,
      [resolved.guideId],
    );
    return NextResponse.json({ success: true, data: { items: rows.map(toGuideCert) } });
  } catch (error) {
    logGuideFailure('GET /api/guide/certifications', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить аттестаты' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const resolved = await resolveGuide(request);
  if (resolved instanceof NextResponse) return resolved;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = CertificationInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const v = parsed.data;

  try {
    const { rows } = await query<GuideCertRow>(
      `INSERT INTO guide_certifications
         (guide_id, name, issuing_authority, certificate_number, issue_date, expiry_date,
          is_verified, source)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, false, 'guide')
       RETURNING ${GUIDE_CERT_COLUMNS}`,
      [resolved.guideId, v.name, v.issuingAuthority, v.certificateNumber, v.issueDate, v.expiryDate ?? null],
    );
    return NextResponse.json(
      { success: true, data: toGuideCert(rows[0]), message: 'Аттестат отправлен на проверку' },
      { status: 201 },
    );
  } catch (error) {
    logGuideFailure('POST /api/guide/certifications', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить аттестат' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
