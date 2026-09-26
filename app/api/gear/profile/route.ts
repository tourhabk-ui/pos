import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { getGearPartnerByUserId, getGearStats } from '@/lib/auth/gear-helpers';
import { requireAuth } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

const UpdateGearProfileSchema = z.object({
  name: z.string().min(1, 'Имя обязательно').optional(),
  partnerName: z.string().min(1, 'Имя партнёра обязательно').optional(),
  description: z.string().optional(),
  contact: z.record(z.string(), z.unknown()).optional(),
});

/**
 * GET /api/gear/profile - Get gear partner profile with stats (auth required)
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;

    const userResult = await query<{ id: string; email: string; name: string; created_at: Date }>(
      'SELECT id, email, name, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Пользователь не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    const user = userResult.rows[0];

    /**
     * Профиль прокатчика здесь НЕ создаётся (решение владельца 26.09).
     *
     * До этого дня GET заводил партнёра `category='gear'` любому вошедшему —
     * то есть читающий запрос выдавал роль и писал в базу. Дальше
     * `POST /api/gear/items` пропускал: профиль-то уже есть.
     *
     * Профиль заводит регистрация партнёра или администратор. Нет профиля —
     * честный 404 с объяснением, а не тихое превращение туриста в прокатчика.
     */
    const partner = await getGearPartnerByUserId(userId);
    if (!partner) {
      return NextResponse.json({
        success: false,
        error: 'Профиль прокатчика не найден. Зарегистрируйтесь как партнёр или напишите в поддержку',
      } as ApiResponse<null>, { status: 404 });
    }

    const stats = await getGearStats(userId);

    return NextResponse.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.created_at
        },
        partner,
        stats
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Ошибка при получении профиля'
    } as ApiResponse<null>, { status: 500 });
  }
}

/**
 * PUT /api/gear/profile - Update gear partner profile (auth required)
 */
export async function PUT(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;

    const body = await request.json();
    const parsed = UpdateGearProfileSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({
        success: false,
        error: parsed.error.issues[0]?.message || 'Некорректные данные'
      } as ApiResponse<null>, { status: 400 });
    }

    const { name, partnerName, description, contact } = parsed.data;

    if (name) {
      await query('UPDATE users SET name = $1 WHERE id = $2', [name, userId]);
    }

    // Тот же довод, что в GET: правка профиля не заводит роль.
    const partner = await getGearPartnerByUserId(userId);
    if (!partner) {
      return NextResponse.json({
        success: false,
        error: 'Профиль прокатчика не найден. Зарегистрируйтесь как партнёр или напишите в поддержку',
      } as ApiResponse<null>, { status: 404 });
    }

    const updateFields = [];
    const updateValues = [];
    let paramIndex = 1;

    if (partnerName) {
      updateFields.push(`name = $${paramIndex++}`);
      updateValues.push(partnerName);
    }

    if (description !== undefined) {
      updateFields.push(`description = $${paramIndex++}`);
      updateValues.push(description);
    }

    if (contact) {
      // Merge, не полная замена: та же семантика, что у PATCH
      // /api/partners/profile — иначе правка одного поля стирала
      // остальные контакты (телефон/telegram терялись при смене сайта)
      updateFields.push(`contact = COALESCE(contact, '{}'::jsonb) || $${paramIndex++}::jsonb`);
      updateValues.push(JSON.stringify(contact));
    }

    if (updateFields.length > 0) {
      updateValues.push(partner!.id);
      await query(
        `UPDATE partners SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex}`,
        updateValues
      );
    }

    const updatedPartner = await getGearPartnerByUserId(userId);

    return NextResponse.json({
      success: true,
      data: { partner: updatedPartner },
      message: 'Профиль успешно обновлён'
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Ошибка при обновлении профиля'
    } as ApiResponse<null>, { status: 500 });
  }
}
