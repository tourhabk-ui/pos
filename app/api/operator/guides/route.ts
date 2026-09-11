/**
 * GET   /api/operator/guides — гиды, привязанные к оператору
 * PATCH /api/operator/guides — включить/выключить доступность гида
 *
 * Появился по итогам аудита бизнес-процессов 25.07: экран /hub/operator/guides
 * полгода показывал трёх выдуманных гидов («Иван Петров», «Мария Сидорова»,
 * «Алексей Козлов») с придуманными рейтингами и кнопкой, которая ничего не
 * делала. Связь в схеме была всё это время — partners.guide_operator_id
 * (миграция 121), — не было только API.
 *
 * Роль: operator (или admin). Оператор видит и меняет ТОЛЬКО своих гидов —
 * проверка по guide_operator_id, не по переданному id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { requireRole } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import type { ApiResponse } from '@/types';
import { GUIDES_SQL, logScreenQueryFailure } from '@/lib/operator/screen-queries';

export const dynamic = 'force-dynamic';

interface GuideRow {
  id: string;
  name: string | null;
  rating: string | null;
  verified_certifications: string;
  is_available: boolean | null;
  tours_count: string;
}

const PatchSchema = z.object({
  guideId: z.string().min(1, 'guideId обязателен'),
  isAvailable: z.boolean(),
});

async function operatorPartnerId(request: NextRequest) {
  const auth = await requireRole(request, ['operator', 'admin']);
  if (auth instanceof NextResponse) return auth;
  const partnerId = await getOperatorPartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json(
      { success: false, error: 'Профиль оператора не найден' } as ApiResponse<null>,
      { status: 404 },
    );
  }
  return partnerId;
}

export async function GET(request: NextRequest) {
  const partnerId = await operatorPartnerId(request);
  if (partnerId instanceof NextResponse) return partnerId;

  try {
    const result = await query<GuideRow>(
      GUIDES_SQL,
      [partnerId],
    );

    return NextResponse.json({
      success: true,
      data: result.rows.map((row) => ({
        id: row.id,
        name: row.name ?? 'Без имени',
        rating: row.rating === null ? null : Number(row.rating),
        verifiedCertifications: Number(row.verified_certifications),
        isAvailable: row.is_available !== false,
        toursCount: Number(row.tours_count),
      })),
    } as ApiResponse<unknown>);
  } catch (error) {
    logScreenQueryFailure('guides', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить гидов. Попробуйте обновить страницу.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const partnerId = await operatorPartnerId(request);
  if (partnerId instanceof NextResponse) return partnerId;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
      { status: 400 },
    );
  }

  try {
    // Условие по guide_operator_id — гид чужого оператора просто не найдётся.
    const result = await query<{ id: string }>(
      `UPDATE partners
       SET is_available = $1, updated_at = NOW()
       WHERE id = $2 AND category = 'guide' AND guide_operator_id = $3
       RETURNING id`,
      [parsed.data.isAvailable, parsed.data.guideId, partnerId],
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Гид не найден среди ваших' } as ApiResponse<null>,
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: { id: result.rows[0].id } } as ApiResponse<unknown>);
  } catch (error) {
    logScreenQueryFailure('guides.patch', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось изменить доступность гида. Попробуйте ещё раз.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
