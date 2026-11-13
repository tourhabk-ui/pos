/**
 * Сообщение адресату заявки от имени клиента — лично, в его MAX или Telegram.
 *
 * Один путь на «Изменить дату» (lib/requests/my-trip-date) и «Отменить
 * заявку» (lib/requests/cancel-request): до отмены он жил внутри смены даты,
 * и вторая копия разошлась бы с первой при первой же правке адресов.
 *
 * Текст без ПД — один на оба канала. `answer` — под сообщением кнопки ответа
 * по заявке (перенос даты: ответ нужен по новой дате). Кнопки туроператора
 * уходят и в Telegram (`stubActions`) — но только в чат, привязанный к
 * карточке: кабинет в Telegram узнаёт оператора по `partners.telegram_chat_id`,
 * а в личный Telegram из `users.telegram_id` кнопка ответила бы «не выполняю».
 * У гида кнопки «Связался / …» — только в MAX. Текст зовёт к кнопкам, только
 * когда они под ним есть (`text(withButtons)`).
 *
 * Исходов четыре, и «не дошло» не равно «некуда»: вызывающий говорит клиенту
 * правду и решает, звать ли менеджера.
 */
import { getPublicBaseUrl } from '@/lib/config';
import { logText } from '@/lib/log/log-text';

/** Исход сообщения оператору: дошло в MAX / заглушкой в Telegram / некуда / адрес не прочитался. */
export type OperatorNotice = 'max' | 'telegram' | 'none' | 'unknown';

/** Дошло ли сообщение до адресата хоть одним каналом. */
export const operatorTold = (n: OperatorNotice): boolean => n === 'max' || n === 'telegram';

export async function notifyRequestOperator(args: {
  operatorId: string;
  leadId: string;
  text: (withButtons: boolean) => string;
  /** Под сообщением — кнопки ответа по заявке. */
  answer?: boolean;
  /** Метка для лога: модуль и о чём сообщение («my-trip-date», «о дате»). */
  log: { tag: string; about: string };
}): Promise<OperatorNotice> {
  const { operatorId, leadId, text, log } = args;
  const { reachForPartner } = await import('@/lib/partners/reach');
  const reach = await reachForPartner(operatorId);
  if (reach === null) {
    console.error(`[${log.tag}] адрес оператора ${operatorId} не прочитался — ${log.about} по заявке ${leadId} не сообщено`);
    return 'unknown';
  }
  if (!reach.reachable) {
    console.error(`[${log.tag}] у оператора ${operatorId} нет ни MAX, ни Telegram — ${log.about} по заявке ${leadId} не сообщено`);
    return 'none';
  }
  const { sendPdAlert } = await import('@/lib/notifications/pd-alert');
  const answers = args.answer ? (await import('@/lib/notifications/lead-notify')).ownerLeadAnswerButtons(reach, leadId) : [];
  const stubActions = reach.category === 'operator' && reach.telegramSource === 'partner' ? answers : [];
  const res = await sendPdAlert({
    text: text(answers.length > 0),
    stub: text(stubActions.length > 0),
    buttons: [...answers, { text: 'Открыть в кабинете', url: `${getPublicBaseUrl()}/hub/operator/leads/${leadId}` }],
    stubActions,
    to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
  });
  if (res.channel === 'max' && res.delivered) return 'max';
  if (res.channel === 'telegram-stub') return 'telegram';
  console.error(`[${log.tag}] оператору ${operatorId} ${log.about} по заявке ${leadId} не доставлено (${res.channel}) — ${logText(res.reason, 160)}`);
  return 'none';
}
