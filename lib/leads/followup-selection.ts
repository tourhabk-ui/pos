/**
 * Какие лиды крон добивки (`GET /api/cron/leads-followup`) вправе отдать
 * другому оператору.
 *
 * Только лиды БЕЗ адресата (`operator_id IS NULL`): подбор через Кузьмича,
 * бота, `create_lead`. Человек просил найти ему тур, и «следующий свободный
 * оператор» — ровно то, о чём он просил.
 *
 * Заявка, адресованная конкретному партнёру, остаётся у адресата: заявка на
 * его тур (`create_booking_request`), на машину перевозчика (`request_charter`,
 * форма `/transfers/[slug]`), письмо со страницы оператора. Человек давал
 * согласие на передачу ЕМУ — у заявки на машину это написано прямо: «передачу
 * перевозчику». Без ответа такие заявки видит Watchdog (`unprocessed_lead`,
 * все лиды старше 2 часов) и кабинет адресата. Решение владельца 13.10:
 * «да, только без адресата» (#2447).
 *
 * До 13.10 отбор брал все `new` старше 2 часов: заявка на машину «Шатуна»
 * через 2 часа ушла бы с именем и телефоном произвольному туроператору, а
 * заявка на тур — конкуренту с той же активностью. Не случалось это только
 * потому, что ни у одного оператора не был привязан мессенджер.
 *
 * Сторож — вызов крона на настоящем PostgreSQL:
 * tests/integration/leads-followup.pg.test.ts.
 */
import { pool } from '@/lib/db-pool';

interface Queryable {
  query: typeof pool.query;
}

export interface LeadSourceData {
  source?: string;
  interests?: string[];
  date_from?: string;
  date_to?: string;
  arrival?: string;    // TripPlanner alias for date_from
  departure?: string;  // TripPlanner alias for date_to
  trip_days?: number;
  chat_id?: string;
  notified_operators?: string[];
  followup_count?: number;
  last_followup?: string;
  escalated_to_admin?: boolean;
}

export interface FollowupLead {
  id: string;
  name: string;
  phone: string;
  source_data: LeadSourceData;
}

/**
 * Лиды без адресата и без ответа: статус `new`, старше 2 часов, прошлое
 * напоминание — тоже раньше 2 часов назад, админу ещё не передан.
 */
export const FOLLOWUP_LEADS_SQL = `
  SELECT id::text, name, phone, source_data
    FROM leads
   WHERE status = 'new'
     AND operator_id IS NULL
     AND created_at < NOW() - INTERVAL '2 hours'
     AND (
       source_data->>'last_followup' IS NULL
       OR (source_data->>'last_followup')::timestamptz < NOW() - INTERVAL '2 hours'
     )
     AND COALESCE((source_data->>'escalated_to_admin')::boolean, false) = false
   ORDER BY created_at ASC
   LIMIT 20
`;

export async function selectFollowupLeads(db: Queryable = pool): Promise<FollowupLead[]> {
  const res = await db.query<FollowupLead>(FOLLOWUP_LEADS_SQL);
  return res.rows;
}
