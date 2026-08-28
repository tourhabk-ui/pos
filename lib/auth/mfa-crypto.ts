/**
 * Шифрование users.mfa_secret at rest.
 *
 * До P1-фикса (аудит 28.08) секрет TOTP хранился в БД открытым текстом —
 * комментарий в старом коде enable-роута прямо признавал: «в production —
 * шифровать перед сохранением». AES-256-GCM, ключ — из MFA_ENCRYPTION_KEY
 * (обязательная переменная окружения, как JWT_SECRET).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

function getKey(): Buffer {
  const secret = process.env.MFA_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('MFA_ENCRYPTION_KEY is required');
  }
  // Ключ произвольной длины на входе (как JWT_SECRET) — hash до 32 байт под AES-256.
  return createHash('sha256').update(secret).digest();
}

export function encryptMfaSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

/**
 * Значения, сохранённые до этого фикса, — открытый текст без префикса `v1:`
 * (сам TOTP-секрет в base32 двоеточий не содержит). Такие возвращаем как
 * есть: следующий вызов /api/auth/mfa/enable перезапишет их уже
 * зашифрованными. Формат распознаём, а не гадаем — молча проглатывать
 * искажённое значение как «расшифровалось» нельзя (§4.0).
 */
export function decryptMfaSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return stored;
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
