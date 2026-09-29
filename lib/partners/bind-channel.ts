/**
 * Записать мессенджер оператора по ссылке привязки (lib/partners/channel-link).
 *
 * Куда пишется. Источник истины для доставки — колонки партнёра:
 * `partners.telegram_chat_id` и `partners.max_chat_id`. Их читают уведомление
 * о брони (`notifyNewBooking` через `reachForPartner`) и перепись
 * operator-reach. Telegram ДОПОЛНИТЕЛЬНО зеркалится в
 * `contacts->>'telegram_chat_id'`: этот ключ до сих пор читают раздача горячих
 * лидов, напоминания по лидам и приёмник оплат оператора (последний — §7, «не
 * трогать»). Без зеркала привязка доходила бы до броней и не доходила бы до
 * лидов — половина механизма, выглядящая целой. Колонка contacts на проде
 * по умолчанию `[]` (baseline), а не `{}`: `[] || объект` даёт МАССИВ и ключ
 * не пишет, поэтому пустой/NULL заменяется пустым объектом, а НЕПУСТОЙ массив не трогается —
 * потерять его содержимое хуже, чем не записать зеркало (колонка при этом
 * пишется всегда) (обзор 29.09). Читатели ключа перечислены в
 * сторожe `tests/unit/partner-channel-link.test.ts`, список может только
 * сокращаться.
 *
 * Перепривязка разрешена — ссылку выдаёт администратор, — но не молча: о ней
 * узнают администратор и ПРЕЖНИЙ чат. Утёкшая ссылка иначе тихо увела бы имена
 * и телефоны туристов в чужой чат.
 *
 * Исходы (§4.0): записано / партнёра нет / база не ответила. Отказ пишется в
 * лог с SQLSTATE и возвращается вызывающему — «не смог» не выдаётся за
 * «привязано».
 */

import { pool } from '@/lib/db-pool';
import { telegramService } from '@/lib/notifications/telegram';
import { maxSendDm } from '@/lib/notifications/max-channel';
import { escapeHtml } from '@/lib/text/escape-html';

export type PartnerChannel = 'telegram' | 'max';

export type BindResult =
  | { ok: true; partnerName: string; previousChatId: string | null; rebound: boolean }
  | { ok: false; reason: 'not_found' | 'db_error' };

const CHANNEL_LABEL: Record<PartnerChannel, string> = { telegram: 'Telegram', max: 'MAX' };

export async function bindPartnerChannel(
  partnerId: string,
  channel: PartnerChannel,
  chatId: number,
): Promise<BindResult> {
  if (!Number.isSafeInteger(chatId)) return { ok: false, reason: 'db_error' };

  // Прежнее значение читается тем же запросом, что пишет, — между чтением и
  // записью нет окна, в котором «прежний чат» успел бы стать другим.
  const sql = channel === 'telegram'
    ? `UPDATE partners p
          SET telegram_chat_id = $1::bigint,
              contacts = CASE
                           -- Непустой массив не трогаем совсем: «массив || объект»
                           -- ДОПИСЫВАЕТ элемент, и ключ по-прежнему не читается.
                           WHEN jsonb_typeof(p.contacts) = 'array' AND p.contacts <> '[]'::jsonb THEN p.contacts
                           ELSE (CASE WHEN jsonb_typeof(p.contacts) = 'object' THEN p.contacts ELSE '{}'::jsonb END)
                                || jsonb_build_object('telegram_chat_id', $1::text)
                         END,
              updated_at = NOW()
         FROM (SELECT id, telegram_chat_id::text AS old FROM partners WHERE id = $2::uuid) prev
        WHERE p.id = prev.id
        RETURNING p.name, prev.old AS previous`
    : `UPDATE partners p
          SET max_chat_id = $1::bigint,
              updated_at = NOW()
         FROM (SELECT id, max_chat_id::text AS old FROM partners WHERE id = $2::uuid) prev
        WHERE p.id = prev.id
        RETURNING p.name, prev.old AS previous`;

  let row: { name: string; previous: string | null } | undefined;
  try {
    ({ rows: [row] } = await pool.query<{ name: string; previous: string | null }>(sql, [String(chatId), partnerId]));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(
      `[bind-channel] ${CHANNEL_LABEL[channel]} партнёра ${partnerId} не записан:`,
      e?.message ?? 'неизвестная ошибка',
      `SQLSTATE=${e?.code ?? 'нет'}`,
    );
    return { ok: false, reason: 'db_error' };
  }
  if (!row) return { ok: false, reason: 'not_found' };

  const previous = row.previous;
  const rebound = previous !== null && previous !== String(chatId);
  await announceBinding(channel, row.name, previous, rebound);
  return { ok: true, partnerName: row.name, previousChatId: previous, rebound };
}

/**
 * Сообщить администратору и прежнему чату. Персональных данных туристов в этих
 * сообщениях нет — только название оператора и канал. Отказ отправки не
 * отменяет привязку, но пишется в лог: «не сообщили» не равно «сообщили».
 */
async function announceBinding(
  channel: PartnerChannel,
  partnerName: string,
  previous: string | null,
  rebound: boolean,
): Promise<void> {
  const label = CHANNEL_LABEL[channel];
  const adminChat = process.env.TELEGRAM_CHAT_ID;
  if (adminChat) {
    const name = escapeHtml(partnerName);
    const text = rebound
      ? `Оператор «${name}»: заявки в ${label} ПЕРЕНЕСЕНЫ в другой чат по ссылке привязки. Если перенос не согласован — выдайте оператору новую ссылку.`
      : `Оператор «${name}» подключил ${label}: заявки будут приходить туда.`;
    const res = await telegramService.sendMessage({ chatId: adminChat, text });
    if (!res.success) console.error(`[bind-channel] администратор не уведомлён о привязке: ${res.error ?? 'нет ответа'}`);
  } else {
    console.error('[bind-channel] TELEGRAM_CHAT_ID не задан — администратор о привязке не уведомлён');
  }

  if (!rebound || previous === null) return;
  const notice = `Заявки оператора «${escapeHtml(partnerName)}» больше не приходят в этот чат — их перенесли в другой по ссылке привязки. Если это сделали не вы, сообщите администратору платформы.`;
  if (channel === 'telegram') {
    const res = await telegramService.sendMessage({ chatId: previous, text: notice });
    if (!res.success) console.error(`[bind-channel] прежний Telegram-чат не уведомлён: ${res.error ?? 'нет ответа'}`);
  } else {
    const res = await maxSendDm(previous, notice);
    if (!res.ok) console.error(`[bind-channel] прежний MAX-чат не уведомлён: ${res.error ?? 'нет ответа'}`);
  }
}

/** Текст ответа в чат, где нажали «Старт». */
export function bindReplyText(channel: PartnerChannel, result: BindResult): string {
  if (!result.ok) {
    return result.reason === 'not_found'
      ? 'Оператор по этой ссылке не найден. Попросите у администратора платформы новую ссылку.'
      : 'Не удалось сохранить привязку — база не ответила. Попробуйте открыть ссылку ещё раз через несколько минут.';
  }
  const tail = channel === 'telegram'
    ? 'Сюда будут приходить номера заявок и ссылки в кабинет. Имя и телефон туриста по закону о персональных данных приходят только в MAX — подключите и его, если ещё нет.'
    : 'Сюда будут приходить заявки туристов с именем и телефоном.';
  return `Готово: ${CHANNEL_LABEL[channel]} подключён к оператору «${escapeHtml(result.partnerName)}». ${tail}`;
}

/** Текст для недействительной ссылки. */
export function badLinkReplyText(reason: 'malformed' | 'bad_signature' | 'expired' | 'no_secret'): string {
  if (reason === 'expired') return 'Ссылка для подключения устарела (действует 72 часа). Попросите у администратора платформы новую.';
  if (reason === 'no_secret') return 'Подключение сейчас недоступно — на платформе не настроена проверка ссылок. Администратор уже может это видеть в логе.';
  return 'Ссылка для подключения недействительна. Попросите у администратора платформы новую.';
}
