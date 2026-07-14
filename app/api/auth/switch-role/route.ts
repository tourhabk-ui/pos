/**
 * POST /api/auth/switch-role
 *
 * Переключение активной роли текущего пользователя («войти как …»).
 * Разрешено, если целевая роль — среди собственных ролей пользователя,
 * либо текущая роль admin (god-mode владельца: любой интерфейс для показа).
 *
 * Меняет users.role, пере-выпускает JWT (cookie auth_token + токен в ответе),
 * сохраняет сессию и пишет аудит. Возвращает redirect на кабинет новой роли.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { createToken } from '@/lib/auth/jwt';
import { ensurePartnerForRole } from '@/lib/auth/partner-profile';
import { getClientIp } from '@/lib/rate-limit';
import { ROLE_HUB } from '@/lib/auth/role-routes';
import { ownedRoles, canSwitchTo, nextOwnedRoles, SWITCHABLE_ROLES } from '@/lib/auth/role-switch';
import type { ApiResponse } from '@/types';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  role: z.enum(SWITCHABLE_ROLES as unknown as [string, ...string[]], {
    errorMap: () => ({ message: 'Недопустимая роль' }),
  }),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' } as ApiResponse<null>, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.errors[0]?.message ?? 'Ошибка валидации' } as ApiResponse<null>,
      { status: 400 },
    );
  }
  const target = parsed.data.role;

  // Текущее состояние пользователя из БД (не доверяем клиенту).
  const { rows } = await pool.query<{ id: string; email: string; name: string; role: string; preferences: unknown }>(
    `SELECT id, email, name, role, preferences FROM users WHERE id = $1 LIMIT 1`,
    [auth.userId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Пользователь не найден' } as ApiResponse<null>, { status: 404 });
  }
  const user = rows[0]!;
  const prefs = (user.preferences ?? {}) as { roles?: unknown };
  const owned = ownedRoles(prefs.roles, user.role);

  if (!canSwitchTo(user.role, owned, target)) {
    return NextResponse.json(
      { success: false, error: 'У вас нет доступа к этой роли' } as ApiResponse<null>,
      { status: 403 },
    );
  }

  // Уже в этой роли — просто отдаём redirect, без лишней записи.
  if (user.role === target) {
    return NextResponse.json({
      success: true,
      data: { role: target, roles: owned, redirect: ROLE_HUB[target] ?? '/hub/tourist' },
    } as ApiResponse<unknown>);
  }

  const newOwned = nextOwnedRoles(user.role, owned, target);

  // Меняем активную роль + сохраняем расширенный owned (god-mode admin бутстрапит admin+target).
  await pool.query(
    `UPDATE users
        SET role = $2,
            preferences = jsonb_set(COALESCE(preferences, '{}'::jsonb), '{roles}', $3::jsonb),
            updated_at = NOW()
      WHERE id = $1`,
    [user.id, target, JSON.stringify(newOwned)],
  );

  // Партнёрским ролям — партнёрский профиль (иначе кабинет пуст). Не блокируем при сбое.
  await ensurePartnerForRole(user.id, target).catch(() => null);

  // Пере-выпуск JWT под новую активную роль.
  const token = await createToken({ userId: user.id, email: user.email, role: target });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await pool.query(
    `INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [user.id, token, expiresAt],
  ).catch(() => {});

  await pool.query(
    `INSERT INTO audit_log (entity_type, entity_id, action, data, ip_address, created_at)
     VALUES ('user', $1, 'role_switch', $2, $3, NOW())`,
    [user.id, JSON.stringify({ from: user.role, to: target }), getClientIp(request.headers)],
  ).catch(() => {});

  const response = NextResponse.json({
    success: true,
    data: { role: target, roles: newOwned, token, redirect: ROLE_HUB[target] ?? '/hub/tourist' },
  } as ApiResponse<unknown>);

  response.cookies.set('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });

  return response;
}
