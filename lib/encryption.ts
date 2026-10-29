/**
 * lib/encryption.ts
 * AES-256-GCM symmetric encryption for user interest data.
 * Key from ENCRYPTION_KEY env var (64-char hex = 32 bytes).
 * Graceful: returns null if key missing or on error.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt plaintext string.
 * Returns "iv:authTag:ciphertext" (all hex) or null on failure.
 */
export function encrypt(plaintext: string): string | null {
  try {
    const key = getKey();
    if (!key) return null;

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch {
    return null;
  }
}

/**
 * Decrypt "iv:authTag:ciphertext" (hex) back to plaintext.
 * Returns null on failure or invalid input.
 */
export function decrypt(encrypted: string): string | null {
  try {
    const key = getKey();
    if (!key) return null;

    const parts = encrypted.split(':');
    if (parts.length !== 3) return null;

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = parts[2];

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch {
    return null;
  }
}

/**
 * Задан ли ключ шифрования. `decrypt` отвечает null одинаково и без ключа,
 * и на испорченной строке; вызывающему, которому эти исходы надо различать
 * (сверка уведомлений агенту: без ключа — «не смог», испорченная строка —
 * исход этой строки), нужен отдельный вопрос.
 */
export function hasEncryptionKey(): boolean {
  return getKey() !== null;
}

/**
 * Шифр, привязанный к строке: `aad` (например, ref подписки) входит в тег
 * GCM, и шифртекст, переставленный в другую строку, не расшифруется. Формат
 * тот же: "iv:authTag:ciphertext" (hex). Ключа нет или сбой — null.
 */
export function encryptBound(plaintext: string, aad: string): string | null {
  const key = getKey();
  if (!key) return null;
  try {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
  } catch (err) {
    console.error('[encryption] encryptBound не зашифровал:', err instanceof Error ? err.name : 'неизвестно');
    return null;
  }
}

/** Обратное к encryptBound с тем же `aad`. Ключа нет, чужая строка или порча — null. */
export function decryptBound(encrypted: string, aad: string): string | null {
  const key = getKey();
  if (!key) return null;
  const parts = encrypted.split(':');
  if (parts.length !== 3) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parts[0], 'hex'), { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
    return decipher.update(parts[2], 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    // Порча или чужая строка — исход вызывающего (он знает, какая строка и
    // что с ней делать); текст ошибки GCM ничего не добавил бы.
    return null;
  }
}
