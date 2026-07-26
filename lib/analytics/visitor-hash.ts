/**
 * Суточный хэш посетителя для первичной аналитики (page_views.visitor_hash).
 *
 * Сырые IP и User-Agent в БД НЕ пишем (152-ФЗ: IP — персональные данные).
 * Вместо них — sha256 от (день + секретная соль + ip + ua): в рамках одних
 * суток один и тот же браузер даёт один хэш (считаем уникальных за день),
 * на следующий день хэш другой — длинного профиля посетителя не строится
 * by design. Обратно IP из хэша с секретной солью не восстановить.
 */

import { createHash } from 'crypto';

export function visitorHash(ip: string, userAgent: string, day: string, salt: string): string {
  return createHash('sha256')
    .update(`${day}:${salt}:${ip}:${userAgent}`)
    .digest('hex')
    .slice(0, 32);
}

/** День в формате YYYY-MM-DD (UTC) — граница смены хэша. */
export function currentDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
