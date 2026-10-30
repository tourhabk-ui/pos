/**
 * Партнёру — решение по его черновику прайса: одобрено или отклонено, с
 * причиной (#2862 этап C). До этого дня ни прокатчик, ни перевозчик о
 * решении не узнавали: одобренный и отклонённый черновик просто пропадал из
 * списка pending, а причина отказа оставалась у администратора.
 *
 * ПД в этом сообщении нет (строка прайса, цена, причина модератора), поэтому
 * текст для MAX и заглушка для Telegram — один и тот же; `sendPdAlert` взят
 * ради строгой адресации (`to`): без отката на рабочий чат платформы. Причина
 * отказа написана человеком — экранируется.
 *
 * Исход — четыре (§4.0): доставлено / Telegram / нет канала / адрес не
 * прочитался; все, кроме доставки, названы в логе. Решение уже записано, и
 * отказ доставки его не отменяет — партнёр увидит итог в кабинете.
 */

import { getPublicBaseUrl } from '@/lib/config';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import type { PersonalLeadOutcome } from '@/lib/notifications/lead-notify';
import { reachForPartner } from '@/lib/partners/reach';
import { escapeHtml } from '@/lib/text/escape-html';

export type EditSubject = 'charter' | 'car_rental';

export interface EditDecisionNotice {
  partnerId: string;
  subject: EditSubject;
  /** Подпись строки прайса словами: направление или название машины. */
  label: string;
  outcome: 'approved' | 'rejected';
  /** Причина отказа модератора; у одобрения null. */
  reason: string | null;
}

const CABINET_PATH: Record<EditSubject, string> = {
  charter: '/hub/carrier',
  car_rental: '/hub/carrier/rental',
};

const SUBJECT_WORD: Record<EditSubject, string> = {
  charter: 'прайса',
  car_rental: 'прайса проката',
};

export function editDecisionText(n: EditDecisionNotice): string {
  const label = escapeHtml(n.label);
  if (n.outcome === 'approved') {
    return [
      `<b>Правка ${SUBJECT_WORD[n.subject]} одобрена</b>`,
      `${label}: правка на сайте.`,
    ].join('\n');
  }
  return [
    `<b>Правка ${SUBJECT_WORD[n.subject]} отклонена</b>`,
    `${label}: на сайте прежняя строка.`,
    n.reason ? `Причина: ${escapeHtml(n.reason)}` : 'Причина не записана.',
    'Исправить и прислать ещё раз можно в кабинете на сайте или в этом чате.',
  ].join('\n');
}

export async function notifyPartnerEditDecision(n: EditDecisionNotice): Promise<PersonalLeadOutcome> {
  const text = editDecisionText(n);
  const reach = await reachForPartner(n.partnerId);
  if (reach === null) {
    console.error(`[partner-edit-notify] адрес партнёра ${n.partnerId} не прочитался — о решении по правке не сообщено`);
    return { state: 'unknown' };
  }
  if (!reach.reachable) {
    console.error(`[partner-edit-notify] у партнёра ${n.partnerId} нет ни MAX, ни Telegram — решение по правке увидит в кабинете`);
    return { state: 'no_channel' };
  }
  const res = await sendPdAlert({
    text,
    stub: text,
    buttons: [{ text: 'Кабинет на сайте', url: `${getPublicBaseUrl()}${CABINET_PATH[n.subject]}` }],
    to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
  });
  if (res.channel === 'max' && res.delivered) return { state: 'delivered', channel: 'max' };
  if (res.channel === 'telegram-stub') return { state: 'stub', channel: 'telegram-stub' };
  console.error(`[partner-edit-notify] партнёру ${n.partnerId} решение по правке не доставлено (${res.channel}) — ${res.reason}`);
  return { state: 'failed', channel: res.channel, reason: res.reason };
}

/** Отправка после решения: решение уже записано, отказ доставки его не отменяет и наружу не роняет. */
export async function notifyPartnerEditDecisionQuietly(n: EditDecisionNotice): Promise<void> {
  try {
    await notifyPartnerEditDecision(n);
  } catch (err) {
    console.error('[partner-edit-notify] отправка упала:', err instanceof Error ? err.message : err);
  }
}
