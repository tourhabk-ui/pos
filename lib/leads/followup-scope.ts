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
 * Тем же замком закрыта заявка на прокат автомобиля (23.10, витрина
 * /car-rental, схема 1317): `source_data.kind = 'car_rental'`, согласие на
 * «передачу прокату автомобилей», версия `PD_CONSENT_RENTAL_VERSION`. Машину
 * без водителя туроператор не сдаст, а согласие человека называло прокат, а не
 * его.
 *
 * Часть поездки, которую ведёт менеджер (`source_data.kind = 'trip_manager'`,
 * разбор 06.11): `create_trip_request` отдаёт менеджеру одной заявкой машину
 * без выбранного перевозчика и жильё на подбор. Адресата у такой заявки нет,
 * но это не подбор тура: туроператор не даст ни машины, ни комнаты, а
 * согласие человека называло туроператора лишь потому, что общей версии
 * «партнёрам поездки» нет. До этой правки через 2 часа без ответа крон
 * отдавал имя и телефон первому попавшемуся туроператору (проба на
 * PostgreSQL). Без ответа такую заявку видит сторож лидов, как и любую.
 *
 * Псевдолиды чата виджета (первое сообщение посетителя без телефона и
 * согласия, записанные до 15.10) — не заявки вовсе: отбор их не берёт
 * (`lib/leads/widget-chat-pseudo`, аудит 15.10, WID-safety).
 *
 * Сторожа: tests/integration/leads-followup.pg.test.ts и
 * tests/integration/car-rental.pg.test.ts (отбор и крон целиком на настоящем
 * PostgreSQL), tests/unit/leads-followup-charter.test.ts (цикл крона
 * пропускает заявку на машину и на прокат, даже если отбор её отдал).
 */
import { PD_CONSENT_CARRIER_VERSION, PD_CONSENT_RENTAL_VERSION } from '@/lib/legal/pd-consent';
import { WIDGET_CHAT_PSEUDO_LEAD_SQL } from '@/lib/leads/widget-chat-pseudo';

/**
 * Роды заявок, адресованных одному партнёру по роду товара: другим партнёрам
 * они не передаются ни при каком адресате.
 */
export const PARTNER_ONLY_LEAD_KINDS = ['charter', 'car_rental'] as const;

/** Род лида — часть поездки, которую ведёт менеджер (create_trip_request). */
export const TRIP_MANAGER_LEAD_KIND = 'trip_manager';

/** Роды, которые крон добивки не передаёт другим партнёрам ни при каком адресате. */
export const NOT_FOR_OTHER_PARTNERS_KINDS: readonly string[] = [...PARTNER_ONLY_LEAD_KINDS, TRIP_MANAGER_LEAD_KIND];

/**
 * Исключение из «только без адресата» — одно (слово владельца 08.11): заявка
 * на группу больше, чем тур берёт на выезд (`source_data.group_over_seats`,
 * lib/mcp/booking-capacity), от которой адресат отказался — кнопкой «Нет мест»
 * или отказом с причиной (`partner_incoming_answers`, 1334). Владелец на
 * вопрос «отдавать ли её другим операторам»: «Да, после „Не могу“». Без ответа
 * адресата она остаётся у него, как любая адресованная. Согласие человека —
 * «передачу туроператору для связи по заявке» (PD_CONSENT_TEXT): получатель
 * не назван поимённо, и добивка заявок без адресата стоит на том же тексте.
 */
export const GROUP_DECLINED_LEAD_SQL = `(
       COALESCE((source_data->>'group_over_seats')::boolean, false)
       AND operator_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM partner_incoming_answers a
          WHERE a.subject_kind = 'lead' AND a.subject_id = leads.id::text
            AND a.partner_id = leads.operator_id AND a.answer IN ('no_seats', 'decline')
       )
     )`;

/**
 * Лиды для добивки: `new` старше 2 часов, без адресата, без свежей добивки, не
 * отданные админу — и не заявки на машину или прокат, и не псевдолиды чата
 * виджета. Плюс заявка на большую группу после отказа адресата (выше).
 * $1 — версия согласия «перевозчику», $2 — «прокату автомобилей».
 * `addressee_slug` — адресат такой заявки: ему её второй раз не отдают.
 */
export const FOLLOWUP_LEADS_SQL = `
  SELECT id::text, name, phone, source_data, pd_consent_version,
         (SELECT p.slug FROM partners p WHERE p.id = leads.operator_id) AS addressee_slug
    FROM leads
   WHERE ((status = 'new' AND operator_id IS NULL)
          OR (status IN ('new', 'lost') AND ${GROUP_DECLINED_LEAD_SQL}))
     AND created_at < NOW() - INTERVAL '2 hours'
     AND (
       source_data->>'last_followup' IS NULL
       OR (source_data->>'last_followup')::timestamptz < NOW() - INTERVAL '2 hours'
     )
     AND COALESCE((source_data->>'escalated_to_admin')::boolean, false) = false
     AND COALESCE(source_data->>'kind', '') <> 'charter'
     AND COALESCE(source_data->>'kind', '') <> 'car_rental'
     AND COALESCE(source_data->>'kind', '') <> '${TRIP_MANAGER_LEAD_KIND}'
     AND COALESCE(pd_consent_version, '') <> $1
     AND COALESCE(pd_consent_version, '') <> $2
     AND NOT ${WIDGET_CHAT_PSEUDO_LEAD_SQL}
   ORDER BY created_at ASC
   LIMIT 20`;

export const FOLLOWUP_LEADS_PARAMS: readonly [string, string] = [PD_CONSENT_CARRIER_VERSION, PD_CONSENT_RENTAL_VERSION];

/**
 * true — заявку другим партнёрам не передают: она адресована одному партнёру
 * по роду товара (машина перевозчика, прокат автомобиля) либо это часть
 * поездки, которую ведёт менеджер (`trip_manager`).
 */
export function addressedToPartnerOnly(
  sourceData: { kind?: unknown } | null | undefined,
  consentVersion: string | null | undefined,
): boolean {
  const kind = sourceData?.kind;
  if (typeof kind === 'string' && NOT_FOR_OTHER_PARTNERS_KINDS.includes(kind)) return true;
  return consentVersion === PD_CONSENT_CARRIER_VERSION || consentVersion === PD_CONSENT_RENTAL_VERSION;
}
