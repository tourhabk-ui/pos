/**
 * PATCH /api/operator/tours/quick-fill
 * Quick update of specific tour fields
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { isQuickFillField, parseQuickFillValue } from '@/lib/operator/quick-fill-fields';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest) {
  const userOrResponse = await requireOperator(request);
  if (userOrResponse instanceof NextResponse) {
    return userOrResponse;
  }

  const userId = userOrResponse.userId;

  try {
    const operatorId = await getOperatorPartnerId(userId);
    if (!operatorId) {
      return NextResponse.json({ error: 'Operator not found' }, { status: 403 });
    }

    const body = await request.json();
    const { tourId, field, value } = body;

    if (!tourId || !field || value === undefined) {
      return NextResponse.json(
        { error: 'Missing tourId, field, or value' },
        { status: 400 }
      );
    }

    // Поле и значение — по общему списку (lib/operator/quick-fill-fields):
    // имя поля идёт в SQL, поэтому только из белого списка; значение — с
    // проверкой типа (раньше в price_unit и difficulty писалась любая строка).
    if (!isQuickFillField(field)) {
      return NextResponse.json({ error: 'Это поле заполняется в редакторе тура' }, { status: 400 });
    }
    const parsed = parseQuickFillValue(field, value);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // Verify tour belongs to operator
    const { rows: tours } = await pool.query(
      `SELECT id FROM operator_tours WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL`,
      [tourId, operatorId]
    );

    if (tours.length === 0) {
      return NextResponse.json(
        { error: 'Tour not found or access denied' },
        { status: 404 }
      );
    }

    // Update field
    const updateQuery = `
      UPDATE operator_tours
      SET ${field} = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, ${field}
    `;

    const { rows } = await pool.query(updateQuery, [parsed.value, tourId]);

    if (rows.length === 0) {
      throw new Error('Failed to update tour');
    }

    return NextResponse.json({
      success: true,
      data: {
        tourId,
        field,
        value: rows[0][field],
      },
    });
  } catch (error) {
    console.error('[operator/quick-fill] отказ:', error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      { error: 'Не удалось сохранить поле' },
      { status: 500 }
    );
  }
}
