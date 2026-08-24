/**
 * POST /api/hub/operator/tours   — Create tour
 * GET  /api/hub/operator/tours   — List tours (paginated)
 * Auth: operator role
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator } from '@/lib/auth/middleware';
import {
  CreateTourSchema,
  PaginationSchema,
  createTour,
  getToursByOperator,
} from '@/lib/api/operator-tours';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';

export async function GET(request: NextRequest) {
  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operator_id = await getOperatorPartnerId(authOrResponse.userId);
    if (!operator_id) {
      return NextResponse.json({ error: 'Not an operator' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const pagination = PaginationSchema.parse({
      limit: searchParams.get('limit'),
      offset: searchParams.get('offset'),
    });

    const data = await getToursByOperator(operator_id, pagination);

    return NextResponse.json({
      success: true,
      data: data.rows,
      pagination: {
        total: data.total,
        limit: data.limit,
        offset: data.offset,
        has_more: data.offset + data.rows.length < data.total,
      },
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    console.error('[hub/operator/tours] GET отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({ error: 'Failed to fetch tours' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operator_id = await getOperatorPartnerId(authOrResponse.userId);
    if (!operator_id) {
      return NextResponse.json({ error: 'You are not registered as an operator' }, { status: 403 });
    }

    const body = await request.json();
    const input = CreateTourSchema.parse(body);

    const result = await createTour(operator_id, authOrResponse.userId, input);

    return NextResponse.json(
      {
        success: true,
        data: result,
        message: 'Tour created successfully. Add availability dates next.',
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    // Мёртвая ветка: ZodError.message — JSON-массив issue-объектов и НИКОГДА
    // не содержит подстроку "validation", поэтому эта проверка не срабатывала
    // ни разу, и любая ошибка валидации (пустой title, отрицательная цена)
    // падала в generic 500 без объяснения (аудит кабинета оператора).
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? 'Некорректные данные' }, { status: 400 });
    }
    const e = error as { code?: string; message?: string };
    console.error('[hub/operator/tours] POST отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({ error: 'Failed to create tour' }, { status: 500 });
  }
}
