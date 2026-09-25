/**
 * POST /api/hub/operator/tours/[id]/availability — Add availability slots
 * GET  /api/hub/operator/tours/[id]/availability — Calendar view (paginated date range)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import {
  AddAvailabilitySchema,
  getTourById,
  addAvailability,
  getAvailability,
} from '@/lib/api/operator-tours';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { ZodError } from 'zod';

export const dynamic = 'force-dynamic';

// Партнёр — через общий getOperatorPartnerId (category='operator'): прежний
// `partners WHERE user_id LIMIT 1` у «гида и оператора» мог взять запись гида,
// и добавление дат к своему туру отвечало 404.
const getOperatorId = getOperatorPartnerId;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const tourId = BigInt(id);

    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operator_id = await getOperatorId(authOrResponse.userId);
    if (!operator_id) {
      return NextResponse.json({ error: 'Not an operator' }, { status: 403 });
    }

    const tour = await getTourById(tourId);
    if (!tour || tour.operator_id !== operator_id) {
      return NextResponse.json({ error: 'Tour not found' }, { status: 404 });
    }

    const body = await request.json();
    const { dates } = AddAvailabilitySchema.parse(body);

    await addAvailability(tourId, dates);

    return NextResponse.json(
      {
        success: true,
        message: `Added ${dates.length} availability dates`,
        dates_added: dates.length,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Проверьте даты и число мест', details: error.flatten() }, { status: 400 });
    }
    console.error('[operator/availability] POST отказ:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Не удалось добавить даты' }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const tourId = BigInt(id);
    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from') || new Date().toISOString().split('T')[0];
    const to =
      searchParams.get('to') ||
      new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    // Календарь и занятость — только своего тура (админ видит любой). До
    // 25.09 любой оператор читал чужое расписание по id.
    if (authOrResponse.role !== 'admin') {
      const operatorId = await getOperatorId(authOrResponse.userId);
      const tour = operatorId ? await getTourById(tourId) : null;
      if (!tour || tour.operator_id !== operatorId) {
        return NextResponse.json({ error: 'Тур не найден' }, { status: 404 });
      }
    }

    const rows = await getAvailability(tourId, from, to);

    return NextResponse.json({
      success: true,
      data: rows,
      date_range: { from, to },
      count: rows.length,
    });
  } catch (error) {
    console.error('[operator/availability] GET отказ:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Не удалось загрузить расписание' }, { status: 500 });
  }
}
