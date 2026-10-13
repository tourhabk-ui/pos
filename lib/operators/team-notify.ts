/**
 * Копия уведомления кабинета — менеджерам команды (CRM 2г-4).
 *
 * Кому. Только АКТИВНЫМ менеджерам кабинета (operator_members.status =
 * 'active') с подключённым мессенджером (lib/operators/member-channel). Статус
 * читается в момент отправки: снятый владельцем менеджер перестаёт получать
 * заявки сразу, без кэша и без «до конца дня».
 *
 * Что. Тот же текст, что уходит чату кабинета, — его строит вызывающий; здесь
 * своих текстов нет. ПД туриста — только через `sendPdAlert` (решение владельца
 * 23.08): `text` уходит в MAX менеджера, в его Telegram — `stub` без ПД.
 * Получатель назван (`to`), отката на рабочий чат платформы нет.
 *
 * Кнопки — только ссылки. Действие (payload) бот принимает только из чата
 * кабинета (запрос мест — requestBelongsToMaxChat) или из рабочего чата
 * платформы; в чате менеджера оно было бы мёртвой кнопкой. Тип это держит.
 *
 * Исход возвращается и не глушится (§4.0): «не смог прочитать команду» —
 * отдельный исход, а не «менеджеров нет». Доставка считается двумя числами:
 * `delivered` — ПД дошли в MAX, `stubbed` — дошла только заглушка в Telegram.
 * Заглушка у менеджера с одним Telegram — штатное состояние, а не отказ, и в
 * лог как отказ не пишется; отказ — «не ушло никуда». На доставку владельцу
 * копия не влияет: исход чата кабинета вызывающий считает как раньше.
 *
 * Менеджерам шлётся параллельно: бронь туриста не ждёт отправок по очереди.
 */

import { pool } from '@/lib/db-pool';
import { sendPdAlert, type PdAlertChannel } from '@/lib/notifications/pd-alert';

export interface MemberReach {
  memberId: string;
  maxChatId: string | null;
  telegramChatId: string | null;
}

interface MemberReachRow {
  member_id: string;
  max_chat_id: string | number | null;
  telegram_chat_id: string | number | null;
}

const asText = (v: string | number | null): string | null => (v == null ? null : String(v));

/** Активные менеджеры кабинета с адресом. null — команду прочитать не удалось. */
export async function teamReach(partnerId: string): Promise<MemberReach[] | null> {
  try {
    const { rows } = await pool.query<MemberReachRow>(
      `SELECT m.id::text AS member_id, m.max_chat_id, m.telegram_chat_id
         FROM operator_members m
        WHERE m.partner_id = $1::uuid
          AND m.status = 'active'
          AND (m.max_chat_id IS NOT NULL OR m.telegram_chat_id IS NOT NULL)`,
      [partnerId],
    );
    return rows.map(r => ({ memberId: r.member_id, maxChatId: asText(r.max_chat_id), telegramChatId: asText(r.telegram_chat_id) }));
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // Таблицы ещё нет (миграция 1223 не применена) — команды нет, это не сбой.
    if (code === '42P01' || code === '42703') return [];
    console.error(`[team-notify] команда кабинета ${partnerId} не прочитана, SQLSTATE ${code ?? 'нет'}`);
    return null;
  }
}

export interface TeamMessage {
  /** С ПД — уходит только в MAX. */
  text: string;
  /** Без ПД — для Telegram. */
  stub: string;
  /** Только ссылки: действие в чате менеджера было бы мёртвой кнопкой. */
  buttons?: Array<{ text: string; url: string }>;
}

export type TeamNotifyResult =
  /** members — кому слали; delivered — ПД дошли в MAX; stubbed — дошла только заглушка в Telegram. */
  | { state: 'sent'; members: number; delivered: number; stubbed: number }
  | { state: 'unknown' };

/**
 * Разослать копию активным менеджерам кабинета. `what` — для лога, без ПД
 * («бронь #123»). Не бросает.
 */
export async function notifyTeam(partnerId: string, msg: TeamMessage, what: string): Promise<TeamNotifyResult> {
  const members = await teamReach(partnerId);
  if (members === null) {
    console.error(`[team-notify] ${what}: команде кабинета ${partnerId} не разослано — команда не прочитана`);
    return { state: 'unknown' };
  }
  const channels = await Promise.all(members.map(async (m): Promise<PdAlertChannel> => {
    try {
      const res = await sendPdAlert({
        text: msg.text,
        stub: msg.stub,
        buttons: msg.buttons,
        to: { maxChatId: m.maxChatId, telegramChatId: m.telegramChatId },
      });
      if (res.channel === 'none') console.error(`[team-notify] ${what}: менеджеру ${m.memberId} не ушло ни в MAX, ни в Telegram — ${res.reason}`);
      return res.channel;
    } catch (err) {
      console.error(`[team-notify] ${what}: менеджеру ${m.memberId} — отказ отправки`, err instanceof Error ? err.message : String(err));
      return 'none';
    }
  }));
  return {
    state: 'sent',
    members: members.length,
    delivered: channels.filter(c => c === 'max').length,
    stubbed: channels.filter(c => c === 'telegram-stub').length,
  };
}

/** То же по туру: кабинет — оператор тура. */
export async function notifyTeamOfTour(tourId: number, msg: TeamMessage, what: string): Promise<TeamNotifyResult> {
  try {
    const { rows } = await pool.query<{ operator_id: string }>(
      `SELECT operator_id::text AS operator_id FROM operator_tours WHERE id = $1`,
      [tourId],
    );
    if (!rows[0]) return { state: 'sent', members: 0, delivered: 0, stubbed: 0 };
    return notifyTeam(rows[0].operator_id, msg, what);
  } catch (err) {
    console.error(`[team-notify] ${what}: кабинет тура ${tourId} не прочитан, SQLSTATE`, (err as { code?: string } | null)?.code ?? 'нет');
    return { state: 'unknown' };
  }
}
