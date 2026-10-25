/**
 * Сколько заявок на прокат машин ждут ответа прокатчика «Беру» или «Не могу».
 *
 * Тот же отбор, что у списка «Заявки» кабинета проката
 * (lib/rental/cabinet-read.ts, REQUESTS_SQL), без строк: только счёт без
 * ответа. Нужен «Входящим» помощника — до 25.10 они у прокатчика отвечали
 * «ничего не ждёт» и «отвечать здесь не нужно», хотя менеджер ждал его
 * ответа на заявку (проверка каналов 25.10).
 */
import { pool } from '@/lib/db-pool';

interface Queryable {
  query: typeof pool.query;
}

export const RENTAL_REQUESTS_WAITING_SQL = `
  SELECT count(*)::int AS n
    FROM leads l
   WHERE l.operator_id = $1::uuid
     AND l.source_data->>'kind' = 'car_rental'
     AND (l.source_data->>'company_id' IS NULL OR l.source_data->>'company_id' = $1::text)
     AND NOT EXISTS (
       SELECT 1 FROM lead_activity_log a
        WHERE a.lead_id = l.id AND a.action = 'partner_answered'
     )`;

export type RentalRequestsWaiting = { outcome: 'ok'; n: number } | { outcome: 'db_error' };

export async function countRentalRequestsWaiting(
  partnerId: string,
  db: Queryable = pool,
): Promise<RentalRequestsWaiting> {
  try {
    const { rows } = await db.query<{ n: number }>(RENTAL_REQUESTS_WAITING_SQL, [partnerId]);
    return { outcome: 'ok', n: Number(rows[0]?.n ?? 0) };
  } catch (err) {
    const e = err as { code?: string };
    console.error('[rental] заявки проката без ответа не посчитаны, SQLSTATE', e?.code ?? 'нет SQLSTATE');
    return { outcome: 'db_error' };
  }
}
