/**
 * lib/leads/followup-scope.ts — какие лиды крон добивки
 * (`/api/cron/leads-followup`) вправе передать другому партнёру.
 *
 * Только лиды БЕЗ адресата (`operator_id IS NULL`): подбор через Кузьмича,
 * бота, `create_lead`. Человек просил найти ему тур, и «следующий свободный
 * оператор» — ровно то, о чём он просил. Решение владельца 13.10: «да, только
 * без адресата» (#2447).
 *
 * Заявка, адресованная партнёру, остаётся у адресата: заявка на его тур
 * (`create_booking_request`), на машину перевозчика (`request_charter`, форма
 * `/transfers/[slug]`), письмо со страницы оператора. Человек давал согласие
 * на передачу ЕМУ. До 13.10 отбор брал все `new` старше 2 часов, и через
 * 2 часа без ответа заявка на тур уходила оператору с той же активностью, то
 * есть конкуренту, а заявка на машину — туроператору «по интересам» или любому
 * с привязанным мессенджером. Без ответа адресованную заявку видят сторож лидов
 * (watchdog, «лиды >2ч» — все лиды, с адресатом и без) и кабинет адресата.
 *
 * Заявку на машину (`source_data.kind = 'charter'`, согласие на «передачу
 * перевозчику», версия `PD_CONSENT_CARRIER_VERSION`) отбор исключает ещё и по
 * роду: у `leads.operator_id` внешний ключ `ON DELETE SET NULL` (миграция 083),
 * и заявка удалённого перевозчика без этого замка стала бы «без адресата».
 * Машину туроператор не даст, а согласие человека его не покрывает.
 *
 * Сторожа: tests/integration/leads-followup.pg.test.ts (отбор и крон целиком
 * на настоящем PostgreSQL), tests/unit/leads-followup-charter.test.ts (цикл
 * крона пропускает заявку на машину, даже если отбор её отдал).
 */
import { PD_CONSENT_CARRIER_VERSION } from '@/lib/legal/pd-consent';

/**
 * Лиды для добивки: `new` старше 2 часов, без адресата, без свежей добивки, не
 * отданные админу — и не заявки на машину. $1 — версия согласия «перевозчику».
 */
export const FOLLOWUP_LEADS_SQL = `
  SELECT id::text, name, phone, source_data, pd_consent_version
    FROM leads
   WHERE status = 'new'
     AND operator_id IS NULL
     AND created_at < NOW() - INTERVAL '2 hours'
     AND (
       source_data->>'last_followup' IS NULL
       OR (source_data->>'last_followup')::timestamptz < NOW() - INTERVAL '2 hours'
     )
     AND COALESCE((source_data->>'escalated_to_admin')::boolean, false) = false
     AND COALESCE(source_data->>'kind', '') <> 'charter'
     AND COALESCE(pd_consent_version, '') <> $1
   ORDER BY created_at ASC
   LIMIT 20`;

export const FOLLOWUP_LEADS_PARAMS: readonly [string] = [PD_CONSENT_CARRIER_VERSION];

/** true — заявка адресована перевозчику, и другим партнёрам она не передаётся. */
export function addressedToCarrier(
  sourceData: { kind?: unknown } | null | undefined,
  consentVersion: string | null | undefined,
): boolean {
  return sourceData?.kind === 'charter' || consentVersion === PD_CONSENT_CARRIER_VERSION;
}
