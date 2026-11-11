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

/** Никогда не бросает: отказ отметки — в лог, чтение статуса он не роняет. */
export async function markNoticeShown(answerId: string, via: ShownVia): Promise<boolean> {
  if (!/^\d{1,18}$/.test(answerId)) return false;
  try {
    const res = await pool.query(NOTICE_SHOWN_SQL, [answerId, via]);
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    console.error(`[answer-notice] отметка «${via}» по ответу ${answerId} не записана, SQLSTATE`, (err as { code?: string }).code ?? 'нет');
    return false;
  }
}
