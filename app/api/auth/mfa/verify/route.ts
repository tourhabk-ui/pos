import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { query } from '@/lib/database';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { decryptMfaSecret } from '@/lib/auth/mfa-crypto';
import { verifyTOTP } from '@/lib/auth/totp';

const mfaVerifyLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!mfaVerifyLimiter.check(ip)) {
    return NextResponse.json(
      { error: 'Слишком много попыток. Попробуйте позже.' },
      { status: 429 }
    );
  }

  try {
    const auth = await verifyAuth(request);
    if (!auth.isAuthenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { token: mfaToken } = await request.json();
    if (!mfaToken || typeof mfaToken !== 'string') {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
    }

    // Получаем сохранённый MFA secret из БД
    const result = await query<{ mfa_secret: string }>(
      'SELECT mfa_secret FROM users WHERE id = $1',
      [auth.userId]
    );

    const user = result.rows[0];
    if (!user?.mfa_secret) {
      return NextResponse.json({ error: 'MFA not configured' }, { status: 400 });
    }

    const verified = verifyTOTP(decryptMfaSecret(user.mfa_secret), mfaToken);

    if (verified) {
      await query(
        'UPDATE users SET mfa_enabled = true WHERE id = $1',
        [auth.userId]
      );
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 400 });
  } catch (err) {
    console.error('[mfa/verify] сбой:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Internal Error' }, { status: 500 });
  }
}
