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
import { managerMay, permissionDenied, requireOperatorTeam } from '@/lib/operators/team-access';
import { formatDateOnly } from '@/lib/dates/date-only';
import { tourHiddenText } from '@/lib/tours/availability-open';
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

    // Кабинет и права — одним резолвером (CRM 2г): право цен нужно не только
    // для цены в запросе, но и чтобы upsert без цены её не сбрасывал.
    const ctx = await requireOperatorTeam(request);
    if (ctx instanceof NextResponse) return ctx;

    const body = await request.json();
    const { dates } = AddAvailabilitySchema.parse(body);
    // Цена на дату — это цена: менеджеру команды только с правом владельца
    // (CRM 2г). Даты и места без своей цены добавляет любой из команды.
    const mayPrice = managerMay(ctx.access, 'can_edit_prices');
    if (!mayPrice && dates.some(d => d.price_override !== undefined)) {
      return permissionDenied('can_edit_prices');
    }

    // Владение (тур кабинета, не удалён) проверяет сама запись — под той же
    // блокировкой тура, что у гейта брони (lib/tours/availability-open).
    // Скрытому туру даты пишутся, как и до 22.10 (карточка тура открыта, тур
    // есть), а ответ говорит, что туристы их пока не видят.
    const outcome = await addAvailability(tourId, dates, mayPrice, ctx.partnerId);
    if (!outcome.ok) {
      if (outcome.reason === 'tour_not_found') {
        return NextResponse.json({ error: 'Тур не найден' }, { status: 404 });
      }
      if (outcome.reason === 'tour_inactive') {
        return NextResponse.json({ error: tourHiddenText(outcome.title) }, { status: 409 });
      }
      return NextResponse.json({ error: 'Не удалось добавить даты' }, { status: 500 });
    }

    // Места ниже числа уже записанных не ставятся: такая дата называется с
    // числом записанных, а не пропадает молча из ответа «добавлено».
    const refused = outcome.perDate.flatMap((r) => (r.result === 'refused_booked' ? [{ date: r.date, taken: r.taken }] : []));
    const refusedText = refused
      .map((r) => `${formatDateOnly(r.date)} — уже записано ${r.taken}`)
      .join('; ');
    if (outcome.written === 0) {
      return NextResponse.json(
        { error: `Даты не открыты: мест меньше, чем уже записано (${refusedText})`, refused },
        { status: 409 },
      );
    }

    const hiddenNote = outcome.tour.isActive
      ? ''
      : '. Тур скрыт — туристы увидят эти даты, когда вы его включите';
    return NextResponse.json(
      {
        success: true,
        message: (refused.length > 0
          ? `Открыто дат: ${outcome.written}. Не открыто: ${refusedText}`
          : `Открыто дат: ${outcome.written}`) + hiddenNote,
        dates_added: outcome.written,
        refused,
        tour_hidden: !outcome.tour.isActive,
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
