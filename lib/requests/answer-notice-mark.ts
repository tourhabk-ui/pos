/**
 * lib/requests/answer-notice-mark.ts — «ответ оператора дошёл» по чтению
 * (план «после отказа», 2б; слово владельца 11.11 «мы доверяем агенту»).
 *
 * Доставкой считается и то, что человек или его ИИ-агент сам прочитал статус
 * заявки, в котором был ЭТОТ ответ: агент — get_request_status по ключу новой
 * заявки (`opens_chat`), страница — открытая на виду. Ключ повтора не в счёт:
 * его получает любой, кто знает чужой телефон, тур и дату.
 *
 * Отдельный модуль без зависимостей от статуса: статус зовёт его, а модуль
 * доставки (answer-notice) зовёт статус.
 */
import { pool } from '@/lib/db-pool';

export type ShownVia = 'agent_read' | 'page_seen' | 'agent_webhook';

/** Ждущее или недоставленное — доставлено; уже доставленное и пропущенное не трогается. */
export const NOTICE_SHOWN_SQL = `
  UPDATE answer_notices
     SET state = 'delivered', delivered_via = $2::text, delivered_at = NOW(),
         decided_at = COALESCE(decided_at, NOW()), claimed_until = NULL
   WHERE answer_id = $1::bigint AND state IN ('pending', 'undelivered')`;

/** То же по ответу перевозчика или прокатчика — записи журнала (2б-2). */
export const NOTICE_SHOWN_BY_ACTIVITY_SQL = `
  UPDATE answer_notices
     SET state = 'delivered', delivered_via = $2::text, delivered_at = NOW(),
         decided_at = COALESCE(decided_at, NOW()), claimed_until = NULL
   WHERE activity_id = $1::bigint AND state IN ('pending', 'undelivered')`;

async function mark(sql: string, id: string, via: ShownVia): Promise<boolean> {
  if (!/^\d{1,18}$/.test(id)) return false;
  try {
    const res = await pool.query(sql, [id, via]);
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    console.error(`[answer-notice] отметка «${via}» по ответу ${id} не записана, SQLSTATE`, (err as { code?: string }).code ?? 'нет');
    return false;
  }
}

/** Никогда не бросает: отказ отметки — в лог, чтение статуса он не роняет. */
export async function markNoticeShown(answerId: string, via: ShownVia): Promise<boolean> {
  return mark(NOTICE_SHOWN_SQL, answerId, via);
}

/** Ответ перевозчика или прокатчика дошёл: номер — записи журнала. */
export async function markVehicleNoticeShown(activityId: string, via: ShownVia): Promise<boolean> {
  return mark(NOTICE_SHOWN_BY_ACTIVITY_SQL, activityId, via);
}

/**
 * Дошёл ответ, из которого построен вид заявки, — каким бы он ни был: кнопка
 * туроператора (`tour`) — по номеру ответа; «Не могу» перевозчика и
 * прокатчика (`vehicle`) и закрытие продавцом с причиной (`closed`, этап 3а) —
 * по записи журнала. Один вход на все двери чтения: род, забытый в одной из
 * них, оставил бы доставленное «недоставленным» — и менеджер звонил бы зря.
 */
export async function markShownRef(ref: { source: 'tour' | 'vehicle' | 'closed'; id: string }, via: ShownVia): Promise<boolean> {
  return mark(ref.source === 'tour' ? NOTICE_SHOWN_SQL : NOTICE_SHOWN_BY_ACTIVITY_SQL, ref.id, via);
}
