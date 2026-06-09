import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { UserDetailRow, UserCheckRow, UserUpdateRow } from '@/lib/types/db-rows';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { id } = await params;

    const result = await query<UserDetailRow>(
      `SELECT
         u.id, u.email, u.name, u.role, u.preferences, u.created_at, u.updated_at,
         COUNT(b.id)::text as bookings_count,
         COALESCE(SUM(COALESCE(b.final_price, b.base_total_price)) FILTER (WHERE b.booking_status = 'confirmed'), 0)::text as total_spent
       FROM users u
       LEFT JOIN operator_bookings b ON b.metadata->>'user_id' = u.id::text
       WHERE u.id = $1
       GROUP BY u.id`,
      [id]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Пользователь не найден' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result.rows[0] } as ApiResponse<UserDetailRow>);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении пользователя' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { id } = await params;
    const PatchSchema = z.object({
      role: z.enum(['user', 'operator', 'guide', 'admin']).optional(),
      name: z.string().min(1).max(255).optional(),
    }).refine(d => d.role !== undefined || d.name !== undefined, {
      message: 'Нет данных для обновления',
    });

    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.errors[0].message }, { status: 400 });
    }

    const checkResult = await query<UserCheckRow>('SELECT id, role FROM users WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Пользователь не найден' }, { status: 404 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (parsed.data.role !== undefined) {
      updates.push(`role = $${paramIndex}`);
      values.push(parsed.data.role);
      paramIndex++;
    }

    if (parsed.data.name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      values.push(parsed.data.name);
      paramIndex++;
    }

    values.push(id);
    const result = await query<UserUpdateRow>(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING id, email, name, role, updated_at`,
      values
    );

    return NextResponse.json({ success: true, data: result.rows[0] } as ApiResponse<UserUpdateRow>);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении пользователя' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { id } = await params;

    const checkResult = await query<UserCheckRow>('SELECT id, role FROM users WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Пользователь не найден' }, { status: 404 });
    }

    if (checkResult.rows[0].role === 'admin') {
      return NextResponse.json({ success: false, error: 'Нельзя удалить администратора' }, { status: 403 });
    }

    await query('DELETE FROM users WHERE id = $1', [id]);

    return NextResponse.json({ success: true, message: 'Пользователь удалён' });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при удалении пользователя' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
