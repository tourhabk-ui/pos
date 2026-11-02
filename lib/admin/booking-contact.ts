/**
 * Кто оставил бронь — для админ-списка броней (/hub/admin/bookings).
 *
 * Повод (02.11): бронь #6 без аккаунта показалась владельцу как «Гость» с
 * пустым Email, хотя имя, телефон и почта лежат в самой брони
 * (tourist_name/phone/email). Список брал контакт только из users по
 * metadata.user_id. Теперь: аккаунт → иначе поля брони → иначе «Гость».
 * Телефон — маской (последние две цифры), как в логах.
 */
import { maskPhone } from '@/lib/notifications/exolve-events';

export interface BookingContactInput {
  user_name?: string | null;
  user_email?: string | null;
  tourist_name?: string | null;
  tourist_email?: string | null;
  tourist_phone?: string | null;
}

export interface BookingContact {
  name: string;
  email: string;
  phoneMasked: string | null;
  hasAccount: boolean;
}

const clean = (s: string | null | undefined) => (s ?? '').trim();

export function bookingContact(r: BookingContactInput): BookingContact {
  const userName = clean(r.user_name);
  const userEmail = clean(r.user_email);
  const phone = clean(r.tourist_phone);
  return {
    name: userName || clean(r.tourist_name) || 'Гость',
    email: userEmail || clean(r.tourist_email),
    phoneMasked: phone ? maskPhone(phone) : null,
    hasAccount: Boolean(userName || userEmail),
  };
}

export { formatKamchatkaDate, KAMCHATKA_TZ } from './kamchatka-date';
