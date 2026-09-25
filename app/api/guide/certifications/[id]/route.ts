import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { logGuideFailure } from '@/lib/guides/db-failure';
import {
  CertificationInputSchema, GUIDE_CERT_COLUMNS, toGuideCert, type GuideCertRow,
} from '@/lib/guides/certification-input';

export const dynamic = 'force-dynamic';

const IdSchema = z.string().uuid('Некорректный идентификатор аттестата');

/**
 * PUT /api/guide/certifications/[id] — гид правит СВОЙ аттестат.
 *
 * Любая правка снимает подтверждение и возвращает запись в «ждёт проверки»:
 * администратор подтверждал другие номер и дату. Это же путь для записей
 * импорта без даты выдачи — гид дописывает дату, и расчёт переаттестации
 * получает, по чему судить.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(request, ['guide', 'admin']);
  if (auth instanceof NextResponse) return auth;

  const idParsed = IdSchema.safeParse((await params).id);
  if (!idParsed.success) {
    return NextResponse.json({ success: false, error: idParsed.error.issues[0]?.message }, { status: 400 });
  }

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

  const guideId = await getGuidePartnerId(auth.userId);
  if (!guideId) {
    return NextResponse.json({ success: false, error: 'Профиль гида не найден' } as ApiResponse<null>, { status: 404 });
  }

  try {
    const { rows } = await query<GuideCertRow>(
      `UPDATE guide_certifications
          SET name               = $3,
              issuing_authority  = $4,
              certificate_number = $5,
              issue_date         = $6::date,
              expiry_date        = $7::date,
              is_verified        = false,
              reviewed_at        = NULL,
              reviewed_by        = NULL,
              review_comment     = NULL,
              updated_at         = NOW()
        WHERE id = $1 AND guide_id = $2
        RETURNING ${GUIDE_CERT_COLUMNS}`,
      [idParsed.data, guideId, v.name, v.issuingAuthority, v.certificateNumber, v.issueDate, v.expiryDate ?? null],
    );
    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Аттестат не найден или принадлежит другому гиду' } as ApiResponse<null>,
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: toGuideCert(rows[0]), message: 'Аттестат отправлен на проверку' });
  } catch (error) {
    logGuideFailure('PUT /api/guide/certifications/[id]', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить аттестат' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
