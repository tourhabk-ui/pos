/**
 * GET /api/auth/max/status?nonce=...
 *
 * Опрос статуса входа через MAX. Пока пользователь не подтвердил в боте —
 * pending. После подтверждения атомарно гасит сессию, находит/создаёт аккаунт
 * по max_user_id, выдаёт JWT + cookie (зеркало /api/auth/telegram).
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { createToken } from '@/lib/auth/jwt';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { getMaxLoginSession, consumeMaxLoginSession } from '@/lib/auth/max-login';

export const dynamic = 'force-dynamic';

const statusLimiter = createRateLimiter({ windowMs: 60_000, max: 60 }); // опрос — чаще

interface MaxUserRow {
  id: string;
  email: string;
  name: string;
  role: string;
}

async function findOrCreateMaxUser(
  maxUserId: number,
  name: string | null,
  username: string | null,
): Promise<MaxUserRow> {
  const existing = await query<MaxUserRow>(
    `SELECT id, email, name, role FROM users WHERE max_user_id = $1 LIMIT 1`,
    [maxUserId],
  );
  if (existing.rows[0]) return existing.rows[0];

  const email = `max_${maxUserId}@max.local`;
  const created = await query<MaxUserRow>(
    `INSERT INTO users (email, name, role, max_user_id, max_username, password_hash, is_active, pd_consent_given)
     VALUES ($1, $2, 'tourist', $3, $4, '', TRUE, TRUE)
     ON CONFLICT (max_user_id) DO UPDATE SET
       max_username = EXCLUDED.max_username,
       name = CASE WHEN users.name = '' THEN EXCLUDED.name ELSE users.name END
     RETURNING id, email, name, role`,
    [email, name ?? 'Путешественник', maxUserId, username ?? null],
  );
  return created.rows[0];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request.headers);
  if (!statusLimiter.check(ip)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов.' }, { status: 429 });
  }

  const nonce = request.nextUrl.searchParams.get('nonce');
  if (!nonce || nonce.length < 8 || nonce.length > 128) {
    return NextResponse.json({ success: false, status: 'invalid' }, { status: 400 });
  }

  const session = await getMaxLoginSession(nonce);
  if (!session) return NextResponse.json({ success: false, status: 'expired' });
  if (new Date(session.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ success: false, status: 'expired' });
  }
  if (session.status === 'pending') {
    return NextResponse.json({ success: false, status: 'pending' });
  }

  // authenticated → атомарно гасим (единожды) и выдаём JWT
  const consumed = await consumeMaxLoginSession(nonce);
  if (!consumed) {
    // уже использован ранее или истёк между чтением и гашением
    return NextResponse.json({ success: false, status: 'expired' });
  }

  const user = await findOrCreateMaxUser(consumed.maxUserId, consumed.name, consumed.username);

  const token = await createToken({ userId: user.id, email: user.email, role: user.role });

  // Строка user_sessions — условие входа, не аудит (см. auth/telegram): без
  // неё verifyAuth отвергнет только что выданный токен (P1, аудит 28.08).
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  try {
    await query(
      `INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt],
    );
  } catch (err) {
    console.error('[auth/max/status] запись сессии не удалась:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, status: 'error', error: 'Не удалось создать сессию. Попробуйте войти ещё раз.' }, { status: 502 });
  }

  const response = NextResponse.json({
    success: true,
    status: 'authenticated',
    data: { id: user.id, email: user.email, name: user.name, role: user.role, token },
  });

  response.cookies.set('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });

  return response;
}
