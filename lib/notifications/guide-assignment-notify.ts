/**
 * Гиду — лично в MAX или Telegram: оператор назначил его на тур или снял с
 * него (05.11, аудит кабинета гида).
 *
 * До этого дня назначение писало только колокольчик на сайте
 * (`notifications`). Гид, который работает в чате бота, о назначении не
 * узнавал, пока сам не открывал «Расписание», а о снятии не узнавал вовсе.
 *
 * ПД туриста в сообщении нет: тур и дата. Состав группы и контакт гид
 * видит в «Расписании» чата и в «Группах» на сайте — там, где они
 * показываются по правилам канала. Поэтому текст для MAX и заглушка для
 * Telegram одинаковы; `sendPdAlert` взят ради строгой адресации (`to`): без
 * отката на рабочий чат платформы. Название тура писал человек —
 * экранируется.
 *
 * Исходы — те же четыре, что у решения по правке (§4.0): доставлено /
 * Telegram / нет канала / адрес не прочитался. Назначение уже записано, и
 * отказ доставки его не отменяет.
 */

import { getPublicBaseUrl } from '@/lib/config';
import { cabinetPayload } from '@/lib/chat-cabinet/payload';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import type { PersonalLeadOutcome } from '@/lib/notifications/lead-notify';
import { reachForPartner } from '@/lib/partners/reach';
import { escapeHtml } from '@/lib/text/escape-html';

export interface GuideAssignmentNotice {
  guidePartnerId: string;
  change: 'assigned' | 'removed';
  tourTitle: string;
  /** Дата брони, YYYY-MM-DD. */
  date: string;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «2027-07-15» → «15 июля 2027»; не дата — как есть. */
function dayWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : iso;
}

export function guideAssignmentText(n: GuideAssignmentNotice): string {
  const what = `«${escapeHtml(n.tourTitle)}», ${escapeHtml(dayWords(n.date))}`;
  if (n.change === 'assigned') {
    return [
      '<b>Вас назначили на тур</b>',
      `${what}.`,
      'Состав группы и контакт — «Расписание» в кабинете в чате, на сайте — раздел «Группы».',
    ].join('\n');
  }
  return [
    '<b>Вас сняли с тура</b>',
    `${what}: оператор снял вас с этой брони.`,
    'Вопросы — оператору, который вас назначал.',
  ].join('\n');
}

export async function notifyGuideAssignment(n: GuideAssignmentNotice): Promise<PersonalLeadOutcome> {
  const text = guideAssignmentText(n);
  const reach = await reachForPartner(n.guidePartnerId);
  if (reach === null) {
    console.error(`[guide-assignment-notify] адрес гида ${n.guidePartnerId} не прочитался — о назначении в чат не сообщено`);
    return { state: 'unknown' };
  }
  if (!reach.reachable) {
    console.error(`[guide-assignment-notify] у гида ${n.guidePartnerId} нет ни MAX, ни Telegram — назначение увидит в кабинете на сайте`);
    return { state: 'no_channel' };
  }
  const site = { text: 'Группы на сайте', url: `${getPublicBaseUrl()}/hub/guide/groups` };
  const res = await sendPdAlert({
    text,
    stub: text,
    buttons: n.change === 'assigned' ? [{ text: 'Расписание', payload: cabinetPayload.schedule() }, site] : [site],
    to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
  });
  if (res.channel === 'max' && res.delivered) return { state: 'delivered', channel: 'max' };
  if (res.channel === 'telegram-stub') return { state: 'stub', channel: 'telegram-stub' };
  console.error(`[guide-assignment-notify] гиду ${n.guidePartnerId} сообщение не доставлено (${res.channel}) — ${res.reason}`);
  return { state: 'failed', channel: res.channel, reason: res.reason };
}

/** Отправка после записи: назначение уже в базе, отказ доставки наружу не роняет. */
export async function notifyGuideAssignmentQuietly(n: GuideAssignmentNotice): Promise<void> {
  try {
    await notifyGuideAssignment(n);
  } catch (err) {
    console.error('[guide-assignment-notify] отправка упала:', err instanceof Error ? err.message : err);
  }
}
