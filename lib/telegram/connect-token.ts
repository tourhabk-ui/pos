/**
 * Telegram Connect Token
 *
 * Позволяет email-пользователям привязать свой Telegram-аккаунт к платформе.
 * Генерирует подписанный HMAC-токен, используемый в deep link:
 *   https://t.me/kuzmichai_bot?start=link_{token}
 *
 * После клика Telegram вызывает /start link_{token} в боте:
 *   - Проверяем подпись
 *   - Сохраняем telegram_id в users
 *   - Отправляем персональное приветствие
 *
 * Токен действителен 30 минут. Никакой DB не нужно.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { telegramBot } from '@/lib/partners/channel-link';

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 минут

/**
 * Ключ подписи. Запасного dev-ключа нет (21.11): без секрета ссылка не
 * выдаётся и не проверяется — fail-closed. Раньше при пустых переменных
 * подпись шла известной всем строкой из публичного репозитория, и токен
 * привязки Telegram к чужому аккаунту мог выписать кто угодно. `||`, а не
 * `??`: переменная, заданная пустой строкой, — это «не задана» (тот же
 * приём, что в lib/partners/channel-link).
 */
function getSecret(): string | null {
  const s = process.env.CONNECT_TOKEN_SECRET || process.env.JWT_SECRET || '';
  return s.length >= 16 ? s : null;
}

/**
 * Генерирует connect-токен для привязки Telegram.
 * Формат: base64url(userId:expiry).hmac
 */
export function generateConnectToken(userId: string): string {
  const secret = getSecret();
  if (!secret) throw new Error('Секрет подписи не задан (CONNECT_TOKEN_SECRET / JWT_SECRET) — ссылка привязки не выдаётся');
  const expiry = Date.now() + TOKEN_TTL_MS;
  const payload = `${userId}:${expiry}`;
  const encoded = Buffer.from(payload).toString('base64url');
  const hmac = createHmac('sha256', secret).update(encoded).digest('hex').slice(0, 16);
  return `${encoded}.${hmac}`;
}

/**
 * Верифицирует токен. Возвращает userId или null если невалиден/истёк.
 */
export function verifyConnectToken(token: string): string | null {
  try {
    const secret = getSecret();
    if (!secret) return null;
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;

    const encoded = token.slice(0, dot);
    const receivedHmac = token.slice(dot + 1);

    // Timing-safe compare
    const expectedHmac = createHmac('sha256', secret).update(encoded).digest('hex').slice(0, 16);
    if (!timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(expectedHmac))) return null;

    const payload = Buffer.from(encoded, 'base64url').toString();
    const [userId, expiryStr] = payload.split(':');
    if (!userId || !expiryStr) return null;

    const expiry = parseInt(expiryStr, 10);
    if (isNaN(expiry) || Date.now() > expiry) return null;

    return userId;
  } catch {
    return null;
  }
}

/**
 * Генерирует полный deep link для привязки Telegram.
 */
export function buildConnectLink(userId: string): string {
  // Имя бота — тем же путём, что у ссылок оператора (getMe → переменная → по умолчанию).
  const botUsername = telegramBot();
  const token = generateConnectToken(userId);
  return `https://t.me/${botUsername}?start=link_${token}`;
}
