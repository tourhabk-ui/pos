import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { verifySessionToken, extractToken } from '@/lib/auth/jwt';
import { ApiResponse } from '@/types';
import { ownedRoles } from '@/lib/auth/role-switch';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/me
 * Get current user info
 */
// JWT validation required — implemented in handler via verifySessionToken
// (подпись И живая строка user_sessions); returns 401 if missing/invalid/revoked.
export async function GET(request: NextRequest) {
  try {
    // Get token from cookie or header
    const cookieToken = request.cookies.get('auth_token')?.value;
    const headerToken = extractToken(request.headers.get('Authorization'));
    const token = cookieToken || headerToken;

    if (!token) {
      return NextResponse.json({
        success: false,
        error: 'Не авторизован'
      } as ApiResponse<null>, { status: 401 });
    }

    // Подпись И строка сессии. Аудит 15.10, P3-01: здесь сверялась только
    // подпись, и после выхода токен ещё до 7 дней отдавал email и имя —
    // отзыв сессии (P1, 28.08) сюда не доходил. Не смогли сверить сессию —
    // 500, а не 401 и не данные: «не знаю» не равно ни «вошёл», ни «гость».
    const session = await verifySessionToken(token);
    if (session.status === 'unchecked') {
      return NextResponse.json({
        success: false,
        error: 'Не удалось проверить сессию'
      } as ApiResponse<null>, { status: 500 });
    }
    if (session.status === 'invalid') {
      return NextResponse.json({
        success: false,
        error: 'Неверный или истекший токен'
      } as ApiResponse<null>, { status: 401 });
    }
    const payload = session.payload;

    // Get user data
    const userResult = await query(
      `SELECT id, email, name, role, preferences, created_at, updated_at
       FROM users
       WHERE id = $1`,
      [payload.userId]
    );

    if (userResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Пользователь не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    const user = userResult.rows[0];
    const prefs = (user.preferences ?? {}) as { roles?: unknown };

    return NextResponse.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        // Реальные роли пользователя (preferences.roles ∪ активная) — нужны
        // гарду кабинетов и переключателю ролей, раньше был хардкод [role].
        roles: ownedRoles(prefs.roles, (user.role as string | null) ?? null),
        preferences: user.preferences || {},
        createdAt: user.created_at,
        updatedAt: user.updated_at
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Ошибка при получении данных пользователя'
    } as ApiResponse<null>, { status: 500 });
  }
}
