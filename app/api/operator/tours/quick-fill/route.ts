/**
 * PATCH /api/operator/tours/quick-fill
 * Одно поле тура с экрана «Чего не хватает».
 *
 * Запись — единая дверь владельца (lib/tours/tour-change, план готовности
 * 23.11, этап 4): название, описание и цена опубликованного тура уходят на
 * проверку, остальное пишется сразу. Ответ говорит, что из двух случилось.
 */

import { NextRequest, NextResponse } from 'next/server';
import { transaction } from '@/lib/database';
import { saveTourChange } from '@/lib/tours/tour-change';
import type { TourPatchInput } from '@/lib/tours/tour-write';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { requireTeamPermission } from '@/lib/operators/team-access';
import { touchesTourPrice } from '@/lib/operators/team-money';
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
    // Цена — право, которое даёт владелец кабинета (CRM 2г).
    if (touchesTourPrice({ [field]: parsed.value })) {
      const denied = await requireTeamPermission(userId, 'can_edit_prices');
      if (denied) return denied;
    }

    // Владение проверяет сама запись: чужой и удалённый тур — «не найден».
    const saved = await transaction((client) => saveTourChange(client, {
      tourId: String(tourId),
      ownerId: operatorId,
      userId,
      input: { [field]: parsed.value } as TourPatchInput,
      current: {},
    }));

    if (saved.outcome === 'not_found') {
      return NextResponse.json(
        { error: 'Tour not found or access denied' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        tourId,
        field,
        value: parsed.value,
      },
      // Поле ушло на проверку: что сказать оператору. null — записано сразу.
      pending: saved.outcome === 'pending' ? saved.pending.notice : null,
    });
  } catch (error) {
    console.error('[operator/quick-fill] отказ:', error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      { error: 'Не удалось сохранить поле' },
      { status: 500 }
    );
  }
}
