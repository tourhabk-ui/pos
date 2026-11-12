import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiResponse } from '@/types';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { ensurePartnerForRole } from '@/lib/auth/partner-profile';
import { getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const validRoles = ['tourist', 'operator', 'guide', 'transfer', 'agent', 'admin', 'stay', 'gear'] as const;
const validLevels = ['L1', 'L2', 'L3'] as const;

const UpdateRoleSchema = z.object({
  userId: z.string().uuid('Укажите корректный ID пользователя'),
  role: z.enum(validRoles, { message: 'Указана недопустимая роль' }),
  level: z.enum(validLevels, { message: 'Указан недопустимый уровень оператора' }).optional(),
  permissions: z.array(z.string()).optional(),
});

// GET /api/roles снят 11.11 (слово владельца «вычисти /api/roles»). Это была
// витрина ролей, которую не читал ни один экран, ни OpenAPI, ни llms.txt, —
// и она обещала то, чего на платформе нет: туристу «оплату» и «мобильное
// приложение», оператору «платёжную систему», перевозчику «бронирование мест»,
// агенту ваучеры и GDS, администратору «управление погодными условиями».
// Что умеет роль, говорит её кабинет; второе описание расходилось бы с ним.
// Остался POST — назначение роли администратором.

// POST /api/roles - Обновление роли пользователя (admin only)
export async function POST(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({
        success: false,
        error: 'Неверный формат запроса',
      } as ApiResponse<null>, { status: 400 });
    }

    const validationResult = UpdateRoleSchema.safeParse(body);
    if (!validationResult.success) {
      const errorMessage = validationResult.error.issues[0]?.message || 'Ошибка валидации';
      return NextResponse.json({
        success: false,
        error: errorMessage,
      } as ApiResponse<null>, { status: 400 });
    }

    const { userId, role, level } = validationResult.data;

    // Валидация уровня для операторов
    if (role === 'operator' && level) {
      if (!validLevels.includes(level as 'L1' | 'L2' | 'L3')) {
        return NextResponse.json({
          success: false,
          error: 'Указан недопустимый уровень оператора',
        } as ApiResponse<null>, { status: 400 });
      }
    }

    // Смена роли: users.role + добавление в preferences.roles (мультироли),
    // уровень оператора — в preferences.operator_level
    const updateResult = await query<{ id: string; email: string; name: string; role: string; preferences: unknown }>(
      `UPDATE users
       SET role = $2,
           preferences = jsonb_set(
             CASE WHEN $3::text IS NULL
                  THEN COALESCE(preferences, '{}'::jsonb)
                  ELSE jsonb_set(COALESCE(preferences, '{}'::jsonb), '{operator_level}', to_jsonb($3::text))
             END,
             '{roles}',
             CASE WHEN COALESCE(preferences->'roles', '[]'::jsonb) ? $2
                  THEN COALESCE(preferences->'roles', '[]'::jsonb)
                  ELSE COALESCE(preferences->'roles', '[]'::jsonb) || to_jsonb($2::text)
             END
           ),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, role, preferences`,
      [userId, role, level ?? null]
    );

    if (updateResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Пользователь не найден',
      } as ApiResponse<null>, { status: 404 });
    }

    // Партнёрским ролям — партнёрский профиль (иначе кабинет пуст)
    const partnerId = await ensurePartnerForRole(userId, role);

    // Аудит смены роли; сбой аудита не блокирует ответ
    await query(
      `INSERT INTO audit_log (entity_type, entity_id, action, data, ip_address, created_at)
       VALUES ('user', $1, 'role_change', $2, $3, NOW())`,
      [
        userId,
        JSON.stringify({ role, level: level || null, changedBy: adminOrResponse.userId }),
        getClientIp(request.headers),
      ]
    ).catch(() => {});

    const updated = updateResult.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        userId: updated.id,
        role: updated.role,
        level: level || null,
        partnerId,
        message: 'Роль пользователя обновлена',
      },
    } as ApiResponse<{ userId: string; role: string; level: string | null; partnerId: string | null; message: string }>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to update role',
      message: error instanceof Error ? error.message : 'Unknown error',
    } as ApiResponse<null>, { status: 500 });
  }
}