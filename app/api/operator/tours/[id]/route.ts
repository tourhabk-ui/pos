import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { OpTourDetailRow, OpTourOwnerRow, CountRow } from '@/lib/types/db-rows';
import { z } from 'zod';

// season/requirements/coordinates убраны: operator_tours не держит таких
// колонок (есть season_start/season_end раздельно, latitude/longitude
// раздельно, requirements не существует вовсе) — записывать их значило бы
// выдумывать несуществующее поле (аудит кабинета оператора нашёл здесь
// UPDATE легаси-таблицы tours, у которой такие колонки БЫЛИ, но она не та
// таблица, где живут настоящие туры).
const UpdateTourSchema = z.object({
  name: z.string().min(1, 'Название не может быть пустым').optional(),
  description: z.string().min(1, 'Описание не может быть пустым').optional(),
  shortDescription: z.string().optional(),
  category: z.string().optional(),
  difficulty: z.string().optional(),
  duration: z.number().min(0.5).max(720).optional(),
  price: z.number().min(0, 'Цена не может быть отрицательной').optional(),
  currency: z.string().optional(),
  maxGroupSize: z.number().int().min(1).max(100).optional(),
  minGroupSize: z.number().int().min(1).optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'Укажите хотя бы одно поле для обновления' }
);

export const dynamic = 'force-dynamic';

const SAFE_DB_COLUMN_REGEX = /^[a-z_][a-z0-9_]*$/;

async function getStrictOperatorContext(
  request: NextRequest
): Promise<{ userId: string; operatorId: string } | NextResponse> {
  const operatorOrResponse = await requireOperator(request);
  if (operatorOrResponse instanceof NextResponse) {
    return operatorOrResponse;
  }

  if (operatorOrResponse.role !== 'operator') {
    return NextResponse.json({
      success: false,
      error: 'Недостаточно прав доступа'
    } as ApiResponse<null>, { status: 403 });
  }

  const operatorId = await getOperatorPartnerId(operatorOrResponse.userId);
  if (!operatorId) {
    return NextResponse.json({
      success: false,
      error: 'Партнёрский профиль оператора не найден'
    } as ApiResponse<null>, { status: 404 });
  }

  return {
    userId: operatorOrResponse.userId,
    operatorId,
  };
}

/**
 * GET /api/operator/tours/[id]
 * Get specific tour with ownership verification
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const operatorContext = await getStrictOperatorContext(request);
    if (operatorContext instanceof NextResponse) {
      return operatorContext;
    }
    const { operatorId } = operatorContext;

    const { id } = await params;

    // Get tour with full details — явные алиасы под реальные колонки
    // operator_tours (title/duration_hours/base_price/max_participants/
    // min_participants/activity_type/included/not_included/latitude/
    // longitude). Раньше здесь стоял `t.*`, а маппинг читал `row.name`,
    // `row.duration`, `row.price`, `row.max_group_size`, `row.season`,
    // `row.requirements`, `row.coordinates` — колонок с такими именами на
    // operator_tours нет вовсе, и ответ 200 нёс NaN/undefined на каждом
    // поле, кроме includes/excludes (тем случайно повезло с именами
    // included/not_included) — аудит кабинета оператора.
      const result = await query<OpTourDetailRow>(
        `SELECT
          t.id, t.title, t.description, t.short_description,
          t.activity_type, t.difficulty, t.duration_hours,
          t.base_price, t.currency,
          t.max_participants, t.min_participants,
          t.included, t.not_included,
          t.latitude, t.longitude,
          t.is_active, t.rating, t.review_count,
          t.created_at, t.updated_at,
          COALESCE(array_agg(DISTINCT a.url) FILTER (WHERE a.url IS NOT NULL), '{}') as images,
          COALESCE(array_agg(DISTINCT jsonb_build_object(
            'id', a.id,
            'url', a.url,
            'alt', a.alt
          )) FILTER (WHERE a.id IS NOT NULL), '[]') as image_details
        FROM operator_tours t
        LEFT JOIN tour_assets ta ON t.id = ta.tour_id
        LEFT JOIN assets a ON ta.asset_id = a.id
        WHERE t.id = $1 AND t.operator_id = $2 AND t.deleted_at IS NULL
        GROUP BY t.id`,
        [id, operatorId]
      );

      if (result.rows.length === 0) {
        return NextResponse.json({
          success: false,
          error: 'Тур не найден'
        } as ApiResponse<null>, { status: 404 });
      }

      const row = result.rows[0];
      const tour = {
        id: row.id,
        name: row.title,
        description: row.description,
        shortDescription: row.short_description,
        category: row.activity_type || 'adventure',
        difficulty: row.difficulty,
        duration: row.duration_hours != null ? parseFloat(String(row.duration_hours)) : null,
        price: row.base_price != null ? parseFloat(String(row.base_price)) : null,
        currency: row.currency,
        includes: row.included || [],
        excludes: row.not_included || [],
        coordinates: row.latitude != null && row.longitude != null
          ? [parseFloat(String(row.latitude)), parseFloat(String(row.longitude))]
          : [],
        maxGroupSize: row.max_participants,
        minGroupSize: row.min_participants,
        isActive: row.is_active,
        rating: row.rating,
        reviewCount: row.review_count,
        images: row.images,
        imageDetails: row.image_details,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

      return NextResponse.json({
        success: true,
        data: tour
      } as ApiResponse<unknown>);

  } catch (error) {
    const e = error as { code?: string; message?: string };
    console.error('[operator/tours/[id]] GET отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({
      success: false,
      error: 'Ошибка при получении тура'
    } as ApiResponse<null>, { status: 500 });
  }
}

/**
 * PUT /api/operator/tours/[id]
 * Update tour with ownership verification
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const operatorContext = await getStrictOperatorContext(request);
    if (operatorContext instanceof NextResponse) {
      return operatorContext;
    }
    const { operatorId } = operatorContext;

    const { id } = await params;

    const body = await request.json();
    const parsed = UpdateTourSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
    }

    // Build dynamic update query — целится в operator_tours (единственная
    // таблица, где живут настоящие туры, CLAUDE.md §4.1). Раньше это было
    // `UPDATE tours` — легаси-таблица, случайно имеющая совпадающие по
    // имени колонки (included/not_included/max_group_size/...), поэтому
    // запрос не падал, а тихо писал в записи, которых для настоящего тура
    // там никогда не было: реальный id+operator_id в tours не находился, и
    // PUT всегда отвечал 404 «Тур не найден» — не крэш, но 100% нерабочий
    // путь (аудит кабинета оператора).
      const allowedFields = [
        'name', 'description', 'shortDescription', 'category', 'difficulty',
        'duration', 'price', 'currency', 'maxGroupSize', 'minGroupSize',
        'includes', 'excludes', 'isActive'
      ];

      const fieldMap: Record<string, string> = {
        name: 'title',
        category: 'activity_type',
        duration: 'duration_hours',
        price: 'base_price',
        shortDescription: 'short_description',
        maxGroupSize: 'max_participants',
        minGroupSize: 'min_participants',
        includes: 'included',
        excludes: 'not_included',
        isActive: 'is_active',
      };

      // included/not_included — TEXT[] (не jsonb): узел pg сериализует JS-
      // массив в SQL-массив сам, JSON.stringify() дал бы строку там, где
      // колонка ждёт text[] — ещё одна ошибка, унаследованная от прежней
      // (неверной) целевой таблицы, где это тоже было не так.

    const updateFields: string[] = [];
    const updateValues: (string | number | boolean | null | string[])[] = [];
    let paramIndex = 1;

      for (const [key, value] of Object.entries(parsed.data)) {
        if (typeof value === 'undefined') {
          continue;
        }

        if (!allowedFields.includes(key)) {
          continue;
        }

        const mappedKey = fieldMap[key] || key;
        const dbKey = mappedKey.replace(/([A-Z])/g, '_$1').toLowerCase();
        if (!SAFE_DB_COLUMN_REGEX.test(dbKey)) {
          return NextResponse.json({
            success: false,
            error: 'Некорректное поле обновления'
          } as ApiResponse<null>, { status: 400 });
        }

        updateFields.push(`${dbKey} = $${paramIndex++}`);
        updateValues.push(value as string | number | boolean | null | string[]);
      }

    if (updateFields.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Нет полей для обновления'
      } as ApiResponse<null>, { status: 400 });
    }

    const idParamIndex = updateValues.length + 1;
    const operatorIdParamIndex = updateValues.length + 2;
    updateValues.push(id);
    updateValues.push(operatorId);

    const result = await query(
      `UPDATE operator_tours
       SET ${updateFields.join(', ')}, updated_at = NOW()
       WHERE id = $${idParamIndex}
         AND operator_id = $${operatorIdParamIndex}
         AND deleted_at IS NULL
       RETURNING *`,
      updateValues
    );

    if (result.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Тур не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: result.rows[0],
      message: 'Тур успешно обновлён'
    } as ApiResponse<unknown>);

  } catch (error) {
    const e = error as { code?: string; message?: string };
    console.error('[operator/tours/[id]] PUT отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({
      success: false,
      error: 'Ошибка при обновлении тура'
    } as ApiResponse<null>, { status: 500 });
  }
}

/**
 * DELETE /api/operator/tours/[id]
 * Delete tour with safety checks
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const operatorContext = await getStrictOperatorContext(request);
    if (operatorContext instanceof NextResponse) {
      return operatorContext;
    }
    const { operatorId } = operatorContext;

    const { id } = await params;

    const tourOwnershipResult = await query<OpTourOwnerRow>(
      `SELECT id FROM operator_tours WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL`,
      [id, operatorId]
    );

    if (tourOwnershipResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Тур не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    // Check for active bookings
    const bookingsCheck = await query<CountRow>(
      `SELECT COUNT(*) as count FROM operator_bookings
       WHERE operator_tour_id = $1 AND booking_status IN ('pending', 'confirmed') AND deleted_at IS NULL`,
      [id]
    );

    if (parseInt(bookingsCheck.rows[0].count) > 0) {
      return NextResponse.json({
        success: false,
        error: 'Невозможно удалить тур с активными бронированиями',
        message: 'Сначала отмените или завершите все активные бронирования, либо деактивируйте тур вместо удаления.'
      } as ApiResponse<null>, { status: 400 });
    }

    // Delete tour (CASCADE will delete related records)
    const deleteResult = await query(
      'DELETE FROM operator_tours WHERE id = $1 AND operator_id = $2 RETURNING id',
      [id, operatorId]
    );

    if (deleteResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Тур не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message: 'Тур успешно удалён'
    } as ApiResponse<null>);

  } catch (error) {
    const e = error as { code?: string; message?: string };
    console.error('[operator/tours/[id]] DELETE отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({
      success: false,
      error: 'Ошибка при удалении тура'
    } as ApiResponse<null>, { status: 500 });
  }
}
