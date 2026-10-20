/**
 * Удаление аккаунта и отзыв согласия на обработку ПД (152-ФЗ, ст. 9 и 21).
 *
 * Согласие — условие аккаунта (регистрация без него невозможна), поэтому
 * отзыв согласия и удаление — одна операция: персональные данные стираются
 * сразу, а не «через 30 дней» (прежний POST /api/user/delete только ставил
 * отметку, и исполнителя у неё не было).
 *
 * Связанные записи не удаляются, а обезличиваются: заявка, отзыв или
 * регистрация маршрута остаются у оператора и в статистике, но без имени,
 * телефона и почты. Строки пользователя в users не удаляются — на неё
 * ссылаются десятки таблиц; вместо этого она обезличена и выключена.
 *
 * Отказ — пока есть живое дело: предстоящая заявка (new / confirmed /
 * pending_payment, дата не прошла) или регистрация маршрута, которая ещё не
 * кончилась. Стереть телефон человека, которого оператор ждёт завтра, или
 * контакт, по которому МЧС поднимет тревогу, — сломать чужую работу.
 *
 * Сторож: tests/integration/account-erase.pg.test.ts.
 */

export interface EraseQueryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const ERASED_NAME = 'Удалённый пользователь';

/** Слово, которое человек вводит для подтверждения удаления. */
export const ERASE_PHRASE = 'УДАЛИТЬ';

export type EraseBlocker = 'upcoming_booking' | 'active_route_registration';

export async function findEraseBlockers(db: EraseQueryable, userId: string): Promise<EraseBlocker[]> {
  const { rows } = await db.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM operator_bookings
          WHERE user_id = $1 AND deleted_at IS NULL
            AND booking_status IN ('new', 'confirmed', 'pending_payment')
            AND COALESCE(end_date, booking_date) >= CURRENT_DATE
       ) AS upcoming_booking,
       EXISTS (
         SELECT 1 FROM route_registrations
          WHERE user_id = $1 AND end_date >= CURRENT_DATE
            AND checkin_confirmed_at IS NULL AND closed_reason IS NULL
       ) AS active_route_registration`,
    [userId],
  );
  const r = rows[0] ?? {};
  const out: EraseBlocker[] = [];
  if (r.upcoming_booking) out.push('upcoming_booking');
  if (r.active_route_registration) out.push('active_route_registration');
  return out;
}

/**
 * Обезличить пользователя и всё, что за ним записано. Вызывать в транзакции.
 * Возвращает число затронутых строк по таблицам — для аудита, без ПД.
 */
export async function eraseUser(
  db: EraseQueryable,
  userId: string,
  reason: 'account_deleted' | 'consent_revoked',
): Promise<Record<string, number>> {
  const N = ERASED_NAME;
  const steps: Array<[string, string]> = [
    ['operator_bookings', `UPDATE operator_bookings SET tourist_name = '${N}', tourist_email = NULL, tourist_phone = NULL WHERE user_id = $1`],
    ['gear_rentals', `UPDATE gear_rentals SET customer_name = '${N}', customer_email = '', customer_phone = '' WHERE user_id = $1`],
    ['transfers', `UPDATE transfers SET client_name = '${N}', client_phone = '', client_email = NULL WHERE user_id = $1`],
    ['support_tickets', `UPDATE support_tickets SET user_name = '${N}', user_email = NULL WHERE user_id = $1`],
    ['sos_events', `UPDATE sos_events SET tourist_name = '${N}', tourist_phone = NULL WHERE user_id = $1`],
    ['booking_waivers', `UPDATE booking_waivers SET signer_name = '${N}', emergency_contact_name = '', emergency_contact_phone = '' WHERE user_id = $1`],
    ['route_registrations', `UPDATE route_registrations SET leader_name = '${N}', leader_phone = '', leader_email = NULL,
        emergency_contact_name = '', emergency_contact_phone = '', emergency_contact_email = NULL,
        emergency_contact_relation = NULL, emergency_contact_telegram_chat_id = NULL, tourist_chat_channel = NULL, tourist_chat_id = NULL
      WHERE user_id = $1`],
    ['crm_contacts', `UPDATE crm_contacts SET display_name = '${N}', phone = NULL, phone_e164 = NULL, email = NULL, email_norm = NULL WHERE user_id = $1`],
    ['reviews', `UPDATE reviews SET author_name = '${N}' WHERE user_id = $1`],
    ['operator_tour_reviews', `UPDATE operator_tour_reviews SET author_name = '${N}', author_city = NULL WHERE user_id = $1`],
    ['carrier_reviews', `UPDATE carrier_reviews SET author_name = '${N}' WHERE user_id = $1`],
    ['tourist_profiles', `DELETE FROM tourist_profiles WHERE user_id = $1`],
    ['user_sessions', `DELETE FROM user_sessions WHERE user_id = $1`],
    ['users', `UPDATE users SET
        email = 'deleted-' || id::text || '@deleted.invalid',
        name = '${N}',
        password_hash = '!erased',
        phone = NULL,
        telegram_id = NULL, telegram_username = NULL, telegram_chat_id = NULL,
        max_user_id = NULL, max_username = NULL,
        mfa_secret = NULL, mfa_enabled = false,
        pd_consent_given = false, marketing_consent = false,
        pd_consent_ip = NULL,
        recommendations = NULL,
        preferences = '{}'::jsonb,
        metadata = jsonb_build_object('erased_at', NOW()::text, 'erase_reason', $2::text),
        is_active = false,
        updated_at = NOW()
      WHERE id = $1`],
  ];
  const counts: Record<string, number> = {};
  for (const [table, sql] of steps) {
    const res = await db.query(sql, table === 'users' ? [userId, reason] : [userId]) as { rowCount?: number };
    counts[table] = res.rowCount ?? 0;
  }
  return counts;
}
