/**
 * lib/leads/followup-scope.ts — какие лиды крон добивки
 * (`/api/cron/leads-followup`) вправе передать другому партнёру.
 *
 * Заявку на машину (`source_data.kind = 'charter'`, согласие на «передачу
 * перевозчику», версия `PD_CONSENT_CARRIER_VERSION`) — никому (#2447). Через
 * 2 часа без ответа крон отдавал её туроператору: «по интересам» или любому
 * с привязанным мессенджером. Машину туроператор не даст, а согласие человека
 * его не покрывает — имя и телефон ушли бы получателю, которого человек не
 * называл. Напоминание о такой заявке не теряется: у менеджера она с момента
 * создания, а сторож лидов (watchdog, «лиды >2ч») зовёт его, если ответа нет.
 *
 * Перераспределять ли другие адресованные заявки (на конкретный тур) — вопрос
 * владельца (#2447); здесь он не решается.
 */
import { PD_CONSENT_CARRIER_VERSION } from '@/lib/legal/pd-consent';

/**
 * Лиды для добивки: `new` старше 2 часов, без свежей добивки, не отданные
 * админу — и не заявки на машину. $1 — версия согласия «перевозчику».
 */
export const FOLLOWUP_LEADS_SQL = `
  SELECT id::text, name, phone, source_data, pd_consent_version
    FROM leads
   WHERE status = 'new'
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
