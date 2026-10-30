/**
 * Счёт пользования кабинетом в чате (слово владельца 30.10: «счёт:
 * пользуются ли»). Без него не видно, нужен ли кабинет вообще: строки CRM
 * от кнопок есть только у записей (звонок, задача), а чтения — «Входящие»,
 * карточка, клиенты — не оставляют следа нигде.
 *
 * Пишется одна строка-счётчик на камчатский день, карточку, место (владелец
 * чата карточки или менеджер команды), канал, действие и исход
 * (`chat_cabinet_usage`, 1354). Ни текста, ни чата, ни человека: по счётчику
 * видно, пользуются ли кабинетом, а не кто что искал (152-ФЗ).
 *
 * Отказ счёта нажатие не останавливает — экран уже собран, и человек его
 * получит; но и не глушится: имя и SQLSTATE в лог (§4.0). Пустой счётчик при
 * упавшей записи читался бы как «не пользуются».
 *
 * Читает перепись `GET /api/cron/chat-cabinet-census`.
 */

import { pool } from '@/lib/db-pool';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import type { CabinetPress } from '@/lib/chat-cabinet/payload';
import type { CabinetChannel, CabinetScreen } from '@/lib/chat-cabinet/screens';

/** Чей чат: карточки партнёра (owner) или менеджера его команды (member). */
export type CabinetSeat = 'owner' | 'member';

/** Что сделано: нажатие кнопки кабинета, раздел словом или кнопкой меню, запрос поиска. */
export type CabinetUsageAction =
  | CabinetPress['kind']
  | 'open_inbox' | 'open_tasks' | 'open_clients' | 'open_more' | 'open_busy'
  | 'search_query';

export const CABINET_USAGE_SQL = `
  INSERT INTO chat_cabinet_usage (day, partner_id, seat, channel, action, outcome)
  VALUES ($1::date, $2::uuid, $3, $4, $5, $6)
  ON CONFLICT (day, partner_id, seat, channel, action, outcome)
  DO UPDATE SET n = chat_cabinet_usage.n + 1`;

interface Queryable {
  query: typeof pool.query;
}

/** Исход по экрану: отказ базы — `failed`, остальное — `ok` (и «не найдено» — ответ, не отказ). */
export function usageOutcome(screen: CabinetScreen): 'ok' | 'failed' {
  return screen.failed === true ? 'failed' : 'ok';
}

export async function countCabinetUse(
  e: { partnerId: string; seat: CabinetSeat; channel: CabinetChannel; action: CabinetUsageAction; screen: CabinetScreen },
  nowMs: number = Date.now(),
  db: Queryable = pool,
): Promise<void> {
  try {
    await db.query(CABINET_USAGE_SQL, [
      kamchatkaDate(new Date(nowMs)), e.partnerId, e.seat, e.channel, e.action, usageOutcome(e.screen),
    ]);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
    console.error(`[chat-cabinet] счёт нажатия (${e.action}) не записан — отказ, SQLSTATE ${code}`);
  }
}
