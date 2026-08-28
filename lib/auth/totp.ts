/**
 * TOTP (RFC 6238) — сверка шестизначного кода. Вынесено из
 * app/api/auth/mfa/verify/route.ts, чтобы /api/auth/mfa/login-verify (второй
 * шаг входа при включённом MFA) не дублировал алгоритм отдельной копией.
 */

import { createHmac, timingSafeEqual } from 'crypto';

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

const TOTP_CODE = /^\d{6}$/;

/**
 * js/user-controlled-bypass, 23.08.2026: CodeQL пометил условие, которым
 * управляет присланное значение. Обхода за этим не оказалось — воротами
 * служит не проверка формы, а сама сверка ниже: код шестизначный, выводится
 * из HMAC-SHA1 по секрету из БД, окно ±1 шаг, попыток 5 в минуту на адрес.
 *
 * Сравнение — постоянного времени (timingSafeEqual), не `===` по строке:
 * длина совпадения не должна утекать по времени ответа.
 */
export function verifyTOTP(secret: string, token: string): boolean {
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
