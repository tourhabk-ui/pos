/**
 * Ссылка-приглашение менеджера в команду оператора (CRM 2г, миграция 1223).
 *
 * Владелец решил 11.10: менеджер попадает в команду «по ссылке от партнёра
 * любым способом». Поэтому ссылка — единственный ключ: кто её открыл и вошёл
 * своим аккаунтом, тот и принимает. Отсюда три правила:
 *   - токен случайный (32 байта), в базе только его sha256;
 *   - ссылка одноразовая и со сроком (7 дней);
 *   - владелец видит, КТО принял (имя и почта аккаунта), и снимает лишнего.
 */
import { createHash, randomBytes } from 'node:crypto';

export { isInviteTokenShape, invitePath } from '@/lib/operators/team-join-path';

export const INVITE_TTL_DAYS = 7;
export const MAX_PENDING_INVITES = 10;

export function generateInviteToken(randomSource: (n: number) => Buffer = randomBytes): string {
  return randomSource(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
