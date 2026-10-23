/**
 * Двухшаговая заявка на прокат (решение 24.10): согласие ставит не агент.
 *
 * Шаг 1 — вызов без `confirmation`: заявка проверяется целиком, но НЕ
 * создаётся; агент получает черновик для человека и код подтверждения.
 * Шаг 2 — тот же вызов с `confirmation` и `consent: true`, только после того
 * как человек прочитал черновик и прямо согласился. Код привязан к полям
 * заявки (прокатчик, машина, даты, имя, телефон, место, пожелания, test) и
 * живёт RENTAL_CONFIRM_TTL_MIN минут: поменялись данные — новый черновик.
 *
 * Хранилища нет: код — HMAC от полей на секрете сервера. Секрета нет —
 * отказ (заявку без проверки шага 1 не пускаем).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const RENTAL_CONFIRM_TTL_MIN = 30;

export interface RentalConfirmFields {
  company: string; car: string; dateFrom: string; dateTo: string;
  name: string; phone: string; pickup: string; comment: string; test: boolean;
}

function secret(): string | null {
  return process.env.MCP_HASH_SALT || process.env.CRON_SECRET || null;
}

function mac(s: string, expMin: number, f: RentalConfirmFields): string {
  const canon = JSON.stringify([expMin, f.company, f.car, f.dateFrom, f.dateTo, f.name, f.phone, f.pickup, f.comment, f.test]);
  return createHmac('sha256', s).update('rental-confirm:' + canon).digest('base64url').slice(0, 22);
}

/** Код подтверждения или null, если секрета нет. */
export function issueRentalConfirmation(f: RentalConfirmFields, now = Date.now()): string | null {
  const s = secret();
  if (!s) return null;
  const expMin = Math.floor(now / 60000) + RENTAL_CONFIRM_TTL_MIN;
  return `${expMin.toString(36)}.${mac(s, expMin, f)}`;
}

export type RentalConfirmCheck = 'ok' | 'expired' | 'mismatch' | 'unavailable';

export function checkRentalConfirmation(code: string, f: RentalConfirmFields, now = Date.now()): RentalConfirmCheck {
  const s = secret();
  if (!s) return 'unavailable';
  const m = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{22})$/.exec(code.trim());
  if (!m) return 'mismatch';
  const expMin = parseInt(m[1], 36);
  const want = Buffer.from(mac(s, expMin, f));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'mismatch';
  return Math.floor(now / 60000) > expMin ? 'expired' : 'ok';
}
