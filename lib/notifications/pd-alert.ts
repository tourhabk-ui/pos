/**
 * Единственная дверь для служебного уведомления С ПЕРСОНАЛЬНЫМИ ДАННЫМИ
 * ТУРИСТА (имя, телефон, почта), адресованного НЕ туристу, а нам — оператору
 * или администратору.
 *
 * Решение владельца 23.08: такие уведомления идут в MAX, а не в Telegram.
 * Замер, из-за которого решение принято: имя и телефон КАЖДОГО лида уходили на
 * api.telegram.org — получателю, которого политика конфиденциальности не
 * называет, и это трансграничная передача ПД. Юрисдикция MAX — РФ.
 *
 * Дверь одна намеренно. Правило, размноженное по вызовам, расходится молча:
 * тот же лид уходил в Telegram тремя разными кусками кода, и починка одного
 * оставляла два.
 *
 * Три исхода, не два (§4.0):
 *   max            — ПД доставлены в MAX;
 *   telegram-stub  — MAX недоступен: в Telegram ушла заглушка БЕЗ ПД (номер
 *                    заявки и ссылка в кабинет), ПД не покинули контур;
 *   none           — доставить не удалось никуда, причина названа и в логе.
 *
 * «Не смог» никогда не выдаётся за «отправлено»: вызывающий получает исход и
 * решает сам.
 */

import { maxSendDm } from '@/lib/notifications/max-channel';

export type PdAlertChannel = 'max' | 'telegram-stub' | 'none';

export interface PdAlertResult {
  channel: PdAlertChannel;
  /** ПД действительно доставлены получателю. Для заглушки — false. */
  delivered: boolean;
  reason: string;
}

/** Ссылка работает в обоих каналах; действие (payload) — только в MAX. */
export type PdAlertButton = { text: string; url: string } | { text: string; payload: string };

export interface PdAlertParams {
  /** Текст С ПД. Уходит ТОЛЬКО в MAX. HTML как в Telegram: <b>, <i>, <a>, <code>. */
  text: string;
  /** Текст БЕЗ ПД для запасного пути в Telegram. Обязателен — умолчания нет. */
  stub: string;
/**
   * Кнопки. Ссылки повторяются и в telegram-заглушке; действия (payload) —
   * только в MAX, потому что заглушка ПД не показывает и действовать по ней
   * нечему.
   */
  buttons?: PdAlertButton[];
  /**
   * Кому. По умолчанию — рабочий чат платформы (MAX_OPERATOR_CHAT_ID, заглушка
   * в TELEGRAM_CHAT_ID). Для уведомления КОНКРЕТНОГО оператора передаётся его
   * пара чатов: ПД пойдут в его MAX, заглушка — в его Telegram.
   */
  to?: { maxChatId?: string | number | null; telegramChatId?: string | number | null };
}

/** Куда слать ПД. Публичный канал (MAX_CHANNEL_ID) сюда не годится — там их увидят все. */
function maxTarget(explicit?: string | number | null): { id: string } | { error: string } {
  const id = explicit != null && String(explicit).trim() !== ''
    ? String(explicit).trim()
    : process.env.MAX_OPERATOR_CHAT_ID?.trim();
  if (!id) {
    return { error: explicit != null ? 'у получателя нет max_chat_id' : 'MAX_OPERATOR_CHAT_ID не задан' };
  }

  const channel = process.env.MAX_CHANNEL_ID?.trim();
  if (channel && id === channel) {
    // MAX_CHANNEL_ID — публичный новостной канал платформы. Телефон туриста
    // там стал бы публикацией, а не уведомлением.
    return { error: 'адрес получателя совпадает с публичным MAX_CHANNEL_ID' };
  }
  return { id };
}

async function telegramStub(
  stub: string,
  buttons?: PdAlertButton[],
  explicitChatId?: string | number | null,
): Promise<boolean> {
  const links = buttons?.filter((b): b is { text: string; url: string } => 'url' in b);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = explicitChatId != null && String(explicitChatId).trim() !== ''
    ? String(explicitChatId).trim()
    : process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  try {
    const res = await fetch(
      `${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: stub,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(links?.length
            ? { reply_markup: { inline_keyboard: links.map((l) => [{ text: l.text, url: l.url }]) } }
            : {}),
        }),
      },
    );
    if (!res.ok) {
      console.error(`[pd-alert] заглушка в Telegram не ушла: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[pd-alert] заглушка в Telegram не ушла: ${e instanceof Error ? e.message : 'fetch error'}`);
    return false;
  }
}

/**
 * Отправить служебное уведомление с ПД туриста.
 * ПД уходят только в MAX; при отказе MAX в Telegram уходит заглушка без ПД.
 */
export async function sendPdAlert(params: PdAlertParams): Promise<PdAlertResult> {
  const target = maxTarget(params.to?.maxChatId);

  if ('error' in target) {
    console.error(`[pd-alert] MAX не настроен: ${target.error} — ПД не отправлены`);
    const stubbed = await telegramStub(params.stub, params.buttons, params.to?.telegramChatId);
    return stubbed
      ? { channel: 'telegram-stub', delivered: false, reason: target.error }
      : { channel: 'none', delivered: false, reason: `${target.error}; заглушка в Telegram тоже не ушла` };
  }

  const res = await maxSendDm(target.id, params.text, { buttons: params.buttons });
  if (res.ok) return { channel: 'max', delivered: true, reason: 'доставлено в MAX' };

  const why = res.error ?? 'MAX API error';
  console.error(`[pd-alert] MAX отказал: ${why} — ПД не отправлены, уходит заглушка`);
  const stubbed = await telegramStub(params.stub, params.buttons, params.to?.telegramChatId);
  return stubbed
    ? { channel: 'telegram-stub', delivered: false, reason: why }
    : { channel: 'none', delivered: false, reason: `${why}; заглушка в Telegram тоже не ушла` };
}
