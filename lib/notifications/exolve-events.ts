/**
 * lib/notifications/exolve-events.ts — проверка и разбор событий SMS от
 * МТС Exolve для роута app/api/exolve/events (роут Next не может
 * экспортировать что-либо, кроме обработчиков).
 */
import { timingSafeCompare } from '@/lib/security/timing-safe';

/** Статусы, при которых сообщение до человека не дошло и не дойдёт. */
export const UNDELIVERED = new Set([
  'DELIVERY_STATUS_FAILED',
  'DELIVERY_STATUS_RETRIES_EXCEEDED',
  'DELIVERY_STATUS_PROHIBITED',
  'STATUS_FAILED',
  'STATUS_UNDERFUNDED',
  'STATUS_PROHIBITED',
]);

/** Номер в лог — только последние две цифры. */
export function maskPhone(raw: string | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length >= 2 ? `***${d.slice(-2)}` : '***';
}

export function isVerifiedExolveEvent(requestUrl: string): boolean {
  const secret = process.env.EXOLVE_WEBHOOK_SECRET;
  if (!secret) return false;
  let provided: string | null = null;
  try { provided = new URL(requestUrl).searchParams.get('s'); } catch { provided = null; }
  return timingSafeCompare(provided ?? '', secret);
}
