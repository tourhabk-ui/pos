/**
 * Счёт главных действий в чате (разбор владельца 02.11): chat_cabinet_usage
 * считал только кабинет — разделы и его кнопки, а ответы на бронь, заявку,
 * машину, жильё и даты шли мимо. По такому счёту «кабинетом не пользуются»,
 * хотя партнёр отвечал каждый день. Теперь нажатие такой кнопки — тоже
 * строка счётчика: день, карточка, канал, действие. Ни текста, ни чата, ни
 * человека (152-ФЗ), как и у кабинета.
 *
 * Счёт не задерживает и не роняет ответ: зовётся без ожидания, отказ — в лог.
 */
import { pool } from '@/lib/db-pool';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { CABINET_USAGE_SQL } from '@/lib/chat-cabinet/usage';

export type MainAction =
  | 'booking_answer' | 'request_answer' | 'car_answer' | 'ride_outcome' | 'lodging_answer' | 'dates_answer';

const PREFIXES: ReadonlyArray<[RegExp, MainAction]> = [
  [/^(?:bk|ld|oc):/, 'booking_answer'],
  [/^ia:/, 'request_answer'],
  [/^rr:/, 'car_answer'],
  [/^rc:/, 'ride_outcome'],
  [/^sa:/, 'lodging_answer'],
  [/^od:/, 'dates_answer'],
];

/** Главное действие по payload (уже без подписи); прочее — null. */
export function mainActionOf(payload: string): MainAction | null {
  for (const [re, a] of PREFIXES) if (re.test(payload)) return a;
  return null;
}

interface Queryable { query: typeof pool.query }

export async function countMainPress(
  e: { channel: 'max' | 'telegram'; chatId: number; payload: string },
  deps: {
    nowMs?: number;
    db?: Queryable;
    findPartner?: (channel: 'max' | 'telegram', chatId: number) => Promise<{ outcome: string; partner?: { partnerId: string } }>;
  } = {},
): Promise<void> {
  const action = mainActionOf(e.payload);
  if (!action) return;
  try {
    const find = deps.findPartner
      ?? (async (ch: 'max' | 'telegram', id: number) => (await import('@/lib/kuzmich/operator-chat')).findPartnerByChat(ch, id));
    const lookup = await find(e.channel, e.chatId);
    if (lookup.outcome !== 'found' || !lookup.partner) return;
    await (deps.db ?? pool).query(CABINET_USAGE_SQL, [
      kamchatkaDate(new Date(deps.nowMs ?? Date.now())), lookup.partner.partnerId, 'owner', e.channel, action, 'ok',
    ]);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
    console.error(`[chat-cabinet] счёт главного действия (${action}) не записан — отказ, SQLSTATE ${code}`);
  }
}
