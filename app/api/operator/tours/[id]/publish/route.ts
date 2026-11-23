import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/lib/database';
import { saveTourChange } from '@/lib/tours/tour-change';
import { ApiResponse } from '@/types';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { OpTourPublishRow } from '@/lib/types/db-rows';

/**
 * POST /api/operator/tours/[id]/publish
 * Показать тур и попросить о публикации.
 *
 * Публикация — просьба (план готовности 23.11, этап 4): «показать тур»
 * действует сразу, а на витрину его ставит только одобрение администратора
 * (lib/tours/tour-change). Тур, уже одобренный и скрытый, возвращается на
 * витрину сразу — проверять в нём нечего.
 *
 * Перед просьбой: название, описание от 20 знаков, цена.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userOrResponse = await requireOperator(request);
    if (userOrResponse instanceof NextResponse) {
      return userOrResponse;
    }

    const operatorId = await getOperatorPartnerId(userOrResponse.userId);
    if (!operatorId) {
      return NextResponse.json({
        success: false,
        error: 'Партнёрский профиль оператора не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    const { id } = await params;

    // Проверяем что тур принадлежит оператору
    const tourResult = await query<OpTourPublishRow>(
      `SELECT id, title AS name, description, base_price AS price, is_active, operator_id
       FROM operator_tours WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );

    if (tourResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Тур не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    const tour = tourResult.rows[0];

    // Проверка владельца
    if (tour.operator_id !== operatorId) {
      return NextResponse.json({
        success: false,
        error: 'Тур не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    // Проверка что тур уже не опубликован
    if (tour.is_active) {
      return NextResponse.json({
        success: false,
        error: 'Тур уже опубликован'
      } as ApiResponse<null>, { status: 400 });
    }

    // Валидация для публикации
    const errors: string[] = [];

    if (!tour.name || tour.name.trim().length < 3) {
      errors.push('Название тура обязательно');
    }
    if (!tour.description || tour.description.trim().length < 20) {
      errors.push('Описание тура обязательно (минимум 20 символов)');
    }
    if (!tour.price || parseFloat(tour.price) <= 0) {
      errors.push('Укажите цену тура');
    }

    if (errors.length > 0) {
      return NextResponse.json({
        success: false,
        error: 'Тур не готов к публикации',
        errors: errors
      } as ApiResponse<null>, { status: 400 });
    }

    // Единая дверь владельца: показ — сразу, публикация — просьба на проверку.
    const saved = await transaction((client) => saveTourChange(client, {
      tourId: String(tour.id),
      ownerId: operatorId,
      userId: userOrResponse.userId,
      input: { is_active: true, is_published: true },
      current: {},
    }));
    if (saved.outcome === 'not_found') {
      return NextResponse.json({ success: false, error: 'Тур не найден' } as ApiResponse<null>, { status: 404 });
    }
    const pending = saved.outcome === 'pending' ? saved.pending : null;

    return NextResponse.json({
      success: true,
      data: {
        id: tour.id,
        name: tour.name,
        status: pending ? 'pending_review' : 'published',
        isActive: true
      },
      message: pending ? pending.notice : 'Тур показан на витрине'
    });

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to publish tour',
      message: error instanceof Error ? error.message : 'Unknown error'
    } as ApiResponse<null>, { status: 500 });
  }
}
