/**
 * POST /api/operator/tours/[id]/generate-tags
 * Генерирует AI-теги для фотографий тура (только для операторов)
 */

import { NextRequest, NextResponse } from 'next/server';
import { tagTourPhotos } from '@/lib/ai/image-tagger';
import { query } from '@/lib/database';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';

export const dynamic = 'force-dynamic';

async function getStrictOperatorId(request: NextRequest): Promise<string | NextResponse> {
  const operatorOrResponse = await requireOperator(request);
  if (operatorOrResponse instanceof NextResponse) {
    return operatorOrResponse;
  }

  if (operatorOrResponse.role !== 'operator') {
    return NextResponse.json(
      { success: false, error: 'Недостаточно прав доступа' },
      { status: 403 }
    );
  }

  const operatorId = await getOperatorPartnerId(operatorOrResponse.userId);
  if (!operatorId) {
    return NextResponse.json(
      { success: false, error: 'Партнёрский профиль оператора не найден' },
      { status: 404 }
    );
  }

  return operatorId;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const operatorIdOrResponse = await getStrictOperatorId(request);
    if (operatorIdOrResponse instanceof NextResponse) {
      return operatorIdOrResponse;
    }
    const operatorId = operatorIdOrResponse;

    const tourId = params.id;

    // Получаем данные тура только при подтверждённом владении.
    const tourResult = await query<{
      id: string;
      title: string;
      photos: string[];
      images: string[];
    }>(
      `SELECT id, title, photos, images
       FROM operator_tours
       WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL`,
      [tourId, operatorId]
    );

    if (tourResult.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Тур не найден' },
        { status: 404 }
      );
    }

    const tour = tourResult.rows[0];

    // Собираем URL фотографий (photos или images поле)
    const photoUrls: string[] = [
      ...(Array.isArray(tour.photos) ? tour.photos : []),
      ...(Array.isArray(tour.images) ? tour.images : []),
    ].filter((url) => typeof url === 'string' && url.startsWith('http'));

    if (photoUrls.length === 0) {
      return NextResponse.json(
        { success: false, error: 'У тура нет фотографий для анализа' },
        { status: 422 }
      );
    }

    // Генерируем теги
    const result = await tagTourPhotos(photoUrls);

    // Ни один снимок не разобран — сообщаем причину и НЕ пишем пустые теги
    // поверх существующих. Раньше здесь молча сохранялся пустой объект, а
    // ответ рапортовал «проанализировано N фото», хотя не удалось ни одно.
    if (result.analyzed === 0) {
      return NextResponse.json(
        { success: false, error: `Не удалось разобрать фотографии: ${result.reason}` },
        { status: 502 }
      );
    }

    // Сохраняем в БД. Раньше UPDATE шёл в таблицу tours, которой в схеме нет
    // (CLAUDE.md: только operator_tours) — то есть теги терялись даже тогда,
    // когда модель их возвращала.
    await query(
      `UPDATE operator_tours
       SET ai_tags = $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND operator_id = $3 AND deleted_at IS NULL`,
      [JSON.stringify(result.tags), tourId, operatorId]
    );

    return NextResponse.json({
      success: true,
      data: {
        tourId,
        tourTitle: tour.title,
        tags: result.tags,
        // Факт, а не замысел: сколько снимков реально дали теги.
        photosAnalyzed: result.analyzed,
        photosAttempted: result.attempted,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка генерации тегов' },
      { status: 500 }
    );
  }
}

/** GET — получить текущие ai_tags тура */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const operatorIdOrResponse = await getStrictOperatorId(request);
    if (operatorIdOrResponse instanceof NextResponse) {
      return operatorIdOrResponse;
    }
    const operatorId = operatorIdOrResponse;
    const tourId = params.id;

    const result = await query<{ ai_tags: Record<string, unknown> }>(
      `SELECT ai_tags
       FROM operator_tours
       WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL`,
      [tourId, operatorId]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: result.rows[0].ai_tags ?? {},
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Ошибка' }, { status: 500 });
  }
}
