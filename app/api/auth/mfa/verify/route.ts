import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { query } from '@/lib/database';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';

const mfaVerifyLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

function base32Decode(base32: string): Buffer {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = base32.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function generateTOTP(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Сверка кода TOTP.
 *
 * js/user-controlled-bypass, 23.08.2026: CodeQL пометил условие, которым
 * управляет присланное значение. Обхода за этим не оказалось — воротами
 * служит не проверка формы, а сама сверка ниже: код шестизначный, выводится
 * из HMAC-SHA1 по секрету из БД, окно ±1 шаг, попыток 5 в минуту на адрес.
 *
 * Что здесь действительно поправлено: сравнение было `===` по строке, то есть
 * НЕ постоянного времени — длина совпадения утекает по времени ответа. При
 * пяти попытках в минуту это не эксплуатируется, но и держать так незачем.
 *
 * Требование ровно шести цифр поведение не меняет: generateTOTP всегда
 * возвращает шесть знаков, и всё, что на них не похоже, совпасть не могло и
 * раньше. Зато оно даёт timingSafeEqual равные длины, без которых он бросает.
 */
const TOTP_CODE = /^\d{6}$/;

function verifyTOTP(secret: string, token: string): boolean {
  if (!TOTP_CODE.test(token)) return false;
  const supplied = Buffer.from(token, 'utf8');
  const counter = Math.floor(Date.now() / 1000 / 30);
  // Проверяем текущий интервал и ±1 шаг (допуск на расхождение часов).
  // Цикл не прерывается досрочно: ранний выход возвращал бы разное время
  // для «совпало на первом шаге» и «совпало на третьем».
  let ok = false;
  for (let delta = -1; delta <= 1; delta++) {
    const expected = Buffer.from(generateTOTP(secret, counter + delta), 'utf8');
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) ok = true;
  }
  return ok;
}

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

    const verified = verifyTOTP(user.mfa_secret, mfaToken);

    if (verified) {
      await query(
        'UPDATE users SET mfa_enabled = true WHERE id = $1',
        [auth.userId]
      );
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'Internal Error' }, { status: 500 });
  }
}
