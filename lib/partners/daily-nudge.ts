/**
 * Напоминание партнёру от Watchdog — не чаще раза в сутки (#3433 п. 6, слово
 * владельца 16.11 «Раз в сутки»).
 *
 * До этого напоминание «у тебя N броней ждут ответа» уходило оператору,
 * владельцу жилья, прокату и перевозчику при КАЖДОМ прогоне сторожа: каждые
 * 30 минут из start.js и раз в час с GitHub — до ~72 одинаковых сообщений в
 * сутки одному человеку, ночью тоже, пока бронь не закрыта. Сторож владельцу
 * дедуп имел (12 ч), партнёру — нет.
 *
 * Правило:
 *  - тихие часы 22–08 по Камчатке — те же, что у напоминаний «Входящих»
 *    (`isQuietHour`, lib/crm/reminders): ночью не шлём, утром первый прогон
 *    после 08:00 напомнит;
 *  - одна отправка на партнёра, вид и камчатские сутки: замок в
 *    `partner_nudges` (1453) ставится ДО отправки, поэтому два прогона сторожа
 *    (start.js и GitHub) не пошлют дважды;
 *  - не доставлено — замок снимается, следующий прогон попробует снова;
 *  - база не ответила — НЕ шлём: это не безопасность, а напоминание, и
 *    «не смог проверить, было ли сегодня» не должно превращаться в повтор
 *    каждые полчаса. Тревога владельцу от этого не зависит — она идёт своим
 *    путём в стороже.
 *
 * Исход назван — вызывающему нужно знать, ушло ли, а не что мы попытались.
 */
import { pool } from '@/lib/db-pool';
import { isQuietHour } from '@/lib/crm/reminders';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import type { NoticeChannel } from '@/lib/partners/notice';

export const NUDGE_KINDS = ['operator_booking', 'stay_booking', 'gear_rental', 'transfer_seat'] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

/** Сколько суток держать строки журнала: дольше они ничему не служат. */
export const NUDGE_KEEP_DAYS = 30;

export type NudgeOutcome =
  | { status: 'sent'; channel: NoticeChannel }
  | { status: 'quiet' }          // 22–08 по Камчатке
  | { status: 'already_today' }  // сегодня уже было (или идёт в другом прогоне)
  | { status: 'undelivered' }    // ни MAX, ни Telegram не приняли — замок снят
  | { status: 'unknown' };       // база не ответила — не шлём

export const NUDGE_CLAIM_SQL = `
  INSERT INTO partner_nudges (partner_id, kind, day, status)
  VALUES ($1::uuid, $2, $3::date, 'sending')
  ON CONFLICT (partner_id, kind, day) DO NOTHING
  RETURNING id`;

export const NUDGE_FINISH_SQL = `
  UPDATE partner_nudges SET status = $2, sent_at = NOW()
  WHERE id = $1::uuid AND status = 'sending'`;

export const NUDGE_RELEASE_SQL = `
  DELETE FROM partner_nudges WHERE id = $1::uuid AND status = 'sending'`;

export const NUDGE_PRUNE_SQL = `
  DELETE FROM partner_nudges WHERE day < $1::date - make_interval(days => $2::int)`;

function failure(step: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `[partner-nudge] ${step}: ${err instanceof Error ? err.message : String(err)}${typeof code === 'string' ? ` (${code})` : ''}`,
  );
}

/**
 * @param partnerId партнёр — по нему замок; без id напоминать нечем помнить, и
 *   такое напоминание не отправляется (исход unknown).
 * @param send сама отправка (sendPartnerNotice) — зовётся только под замком.
 */
export async function nudgePartnerOncePerDay(
  partnerId: string | null,
  kind: NudgeKind,
  send: () => Promise<NoticeChannel | null>,
  now: Date = new Date(),
): Promise<NudgeOutcome> {
  if (isQuietHour(now)) return { status: 'quiet' };
  if (!partnerId) {
    console.error(`[partner-nudge] ${kind}: у строки нет id партнёра — напоминание не отправлено`);
    return { status: 'unknown' };
  }
  const day = kamchatkaDate(now);

  let claimId: string;
  try {
    const { rows } = await pool.query<{ id: string }>(NUDGE_CLAIM_SQL, [partnerId, kind, day]);
    if (rows.length === 0) return { status: 'already_today' };
    claimId = rows[0].id;
  } catch (err) {
    failure(`замок ${kind}`, err);
    return { status: 'unknown' };
  }

  let channel: NoticeChannel | null = null;
  try {
    channel = await send();
  } catch (err) {
    failure(`отправка ${kind}`, err);
  }

  if (!channel) {
    try {
      await pool.query(NUDGE_RELEASE_SQL, [claimId]);
    } catch (err) {
      // Замок остался — сегодня больше не напомним; это лучше повтора, но
      // назвать надо.
      failure(`снятие замка ${kind}`, err);
    }
    return { status: 'undelivered' };
  }

  try {
    await pool.query(NUDGE_FINISH_SQL, [claimId, channel]);
    await pool.query(NUDGE_PRUNE_SQL, [day, NUDGE_KEEP_DAYS]);
  } catch (err) {
    failure(`отметка ${kind}`, err);
  }
  return { status: 'sent', channel };
}

/**
 * Строка для тревоги владельцу: что стало с напоминаниями партнёрам в этом
 * прогоне. «Не доставлено никому» говорится только про настоящую недоставку —
 * «сегодня уже напоминали» и «ночь» не выдаются за отказ канала.
 */
export function nudgeSummary(outcomes: readonly NudgeOutcome[]): string {
  const n = (s: NudgeOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  const parts: string[] = [];
  if (n('sent') > 0) parts.push(`уведомлено напрямую сейчас: ${n('sent')}`);
  if (n('already_today') > 0) parts.push(`уже напоминали сегодня: ${n('already_today')}`);
  if (n('quiet') > 0) parts.push(`ночь по Камчатке, напомним после 08:00: ${n('quiet')}`);
  if (n('undelivered') > 0) parts.push(`не доставлено (MAX и Telegram отказали, причина в логе): ${n('undelivered')}`);
  if (n('unknown') > 0) parts.push(`не отправлено, журнал напоминаний не ответил: ${n('unknown')}`);
  if (parts.length === 0) return ' Напрямую не уведомлён никто: нет ни MAX, ни Telegram.';
  return ` Напоминания партнёрам — ${parts.join('; ')}.`;
}
