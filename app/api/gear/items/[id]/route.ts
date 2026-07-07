import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { verifyGearItemOwnership } from '@/lib/auth/gear-helpers';
import { requireAuth } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid('Некорректный ID снаряжения') });

const UpdateGearItemSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().min(1).optional(),
  subcategory: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  pricePerDay: z.number().positive('Цена должна быть положительной').optional(),
  pricePerWeek: z.number().nullable().optional(),
  pricePerMonth: z.number().nullable().optional(),
  quantity: z.number().int().positive('Количество должно быть целым числом больше 0').optional(),
  depositAmount: z.number().nullable().optional(),
  insuranceCostPerDay: z.number().nullable().optional(),
  images: z.array(z.string()).optional(),
  specifications: z.record(z.unknown()).optional(),
  features: z.array(z.string()).optional(),
  condition: z.string().optional(),
  tags: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'Нет полей для обновления' });

/**
 * PUT /api/gear/items/[id] - Частичное обновление снаряжения (владелец)
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;

    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { success: false, error: 'Некорректный ID снаряжения' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const itemId = parsedParams.data.id;

    const owns = await verifyGearItemOwnership(userId, itemId);
    if (!owns) {
      return NextResponse.json(
        { success: false, error: 'Снаряжение не найдено' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const body = await request.json();
    const parsed = UpdateGearItemSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // camelCase поля запроса → snake_case колонки; JSONB-поля сериализуются.
    const columnMap: Record<string, { column: string; transform?: (v: unknown) => unknown }> = {
      name: { column: 'name' },
      description: { column: 'description' },
      category: { column: 'category' },
      subcategory: { column: 'subcategory' },
      brand: { column: 'brand' },
      model: { column: 'model' },
      pricePerDay: { column: 'price_per_day' },
      pricePerWeek: { column: 'price_per_week' },
      pricePerMonth: { column: 'price_per_month' },
      depositAmount: { column: 'deposit_amount' },
      insuranceCostPerDay: { column: 'insurance_cost_per_day' },
      images: { column: 'images', transform: v => JSON.stringify(v) },
      specifications: { column: 'specifications', transform: v => JSON.stringify(v) },
      features: { column: 'features', transform: v => JSON.stringify(v) },
      condition: { column: 'condition' },
      tags: { column: 'tags' },
      isActive: { column: 'is_active' },
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(parsed.data)) {
      if (key === 'quantity') continue;
      const mapping = columnMap[key];
      if (!mapping) continue;
      setClauses.push(`${mapping.column} = $${idx}`);
      values.push(mapping.transform ? mapping.transform(value) : value);
      idx++;
    }

    // Общее количество меняется с сохранением числа выданных единиц:
    // available = new_quantity - (старое quantity - старое available), не ниже 0.
    if (parsed.data.quantity !== undefined) {
      setClauses.push(`quantity = $${idx}`);
      setClauses.push(`available_quantity = GREATEST(0, $${idx} - (quantity - available_quantity))`);
      values.push(parsed.data.quantity);
      idx++;
    }

    setClauses.push('updated_at = NOW()');
    values.push(itemId);

    const result = await query(
      `UPDATE gear_items SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    return NextResponse.json({
      success: true,
      data: result.rows[0],
      message: 'Снаряжение обновлено'
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении снаряжения' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/gear/items/[id] - Мягкая деактивация (на позицию могут ссылаться аренды)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;

    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { success: false, error: 'Некорректный ID снаряжения' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const itemId = parsedParams.data.id;

    const owns = await verifyGearItemOwnership(userId, itemId);
    if (!owns) {
      return NextResponse.json(
        { success: false, error: 'Снаряжение не найдено' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    await query(
      `UPDATE gear_items SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [itemId]
    );

    return NextResponse.json({
      success: true,
      message: 'Снаряжение снято с публикации'
    } as ApiResponse<null>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при удалении снаряжения' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
