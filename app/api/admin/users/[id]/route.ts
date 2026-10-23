import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { query, transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { UserDetailRow, UserCheckRow, UserUpdateRow } from '@/lib/types/db-rows';
import { ensurePartnerForRole } from '@/lib/auth/partner-profile';
import { applyAdminRoleChange } from '@/lib/auth/admin-role-change';

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
    // 'user' — legacy-значение роли туриста, встречается в старых записях
    const PatchSchema = z.object({
      role: z.enum(['user', 'tourist', 'operator', 'guide', 'transfer', 'agent', 'stay', 'gear', 'admin']).optional(),
      name: z.string().min(1).max(255).optional(),
    }).refine(d => d.role !== undefined || d.name !== undefined, {
      message: 'Нет данных для обновления',
    });

    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }

    const checkResult = await query<UserCheckRow>('SELECT id, role FROM users WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Пользователь не найден' }, { status: 404 });
    }

    // Роль — одной транзакцией с собственными ролями, отзывом сессий снятого
    // админа и записью в журнал (lib/auth/admin-role-change, ревью 23.10):
    // прежний `SET role` оставлял `admin` в preferences.roles, и снятый
    // админ тут же возвращал его себе через switch-role.
    const role = parsed.data.role;
    const name = parsed.data.name;
    const result = await transaction(async (client) => {
      if (role !== undefined) await applyAdminRoleChange(client, id, role, adminOrResponse.userId);
      if (name !== undefined) {
        await client.query(`UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2`, [name, id]);
      }
      return client.query<UserUpdateRow>(`SELECT id, email, name, role, updated_at FROM users WHERE id = $1`, [id]);
    });

    // Партнёрским ролям — партнёрский профиль (иначе кабинет пуст)
    if (parsed.data.role !== undefined) {
      await ensurePartnerForRole(id, parsed.data.role);
    }

    return NextResponse.json({ success: true, data: result.rows[0] } as ApiResponse<UserUpdateRow>);
  } catch (error) {
    const code = (error as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[admin/users PATCH] пользователь не обновлён, SQLSTATE', code);
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
