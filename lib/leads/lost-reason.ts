/**
 * lib/leads/lost-reason.ts — почему продавец закрыл заявку «Отказ» (план
 * «после отказа», этап 3а; слово владельца 11.11 «карт-бланш по плану действуй»).
 *
 * До этой правки «Потерян» в кабинете на сайте и «Отказ» у гида закрывали
 * заявку молча: причины не было, человеку ничего не уходило, а статус для
 * него читался «отказал или не состоялась» — хотя кнопка «Отказать» в чате
 * уже сообщала причину и свободные даты рядом (2б). У одной и той же правды
 * было две двери с разным исходом для человека.
 *
 * Теперь у закрытия два рода причин, и род решает, что узнаёт человек:
 *  - отказ продавца (те же причины, что у кнопки чата) — человеку уходит
 *    сообщение Ведара, как после «Отказать»;
 *  - причина на стороне клиента («не отвечает», «передумал») — сообщение не
 *    уходит: человек о своём решении знает, а «оператор не дозвонился»
 *    сообщением в чат было бы упрёком. Статус заявки при этом говорит правду
 *    словами «по словам оператора».
 *
 * Модуль без базы и сети — его импортируют и клиентские экраны.
 */
import { DECLINE_REASONS, DECLINE_REASON_LABEL, isDeclineReason, type DeclineReason } from '@/lib/requests/decline-reasons';

/** Причина на стороне клиента: продавец закрывает заявку не потому, что отказывает сам. */
export const CLIENT_LOST_REASONS = ['no_contact', 'client_declined'] as const;
export type ClientLostReason = (typeof CLIENT_LOST_REASONS)[number];

/** Отказ продавца — те же причины, что у кнопки «Отказать» в чате. */
export const SELLER_LOST_REASONS = DECLINE_REASONS;

export const LOST_REASONS = [...SELLER_LOST_REASONS, ...CLIENT_LOST_REASONS] as const;
export type LostReason = DeclineReason | ClientLostReason;

export const LOST_REASON_LABEL: Record<LostReason, string> = {
  ...DECLINE_REASON_LABEL,
  no_contact: 'Клиент не отвечает',
  client_declined: 'Клиент передумал',
};

export function isLostReason(v: unknown): v is LostReason {
  return typeof v === 'string' && (LOST_REASONS as readonly string[]).includes(v);
}

export function isClientLostReason(v: unknown): v is ClientLostReason {
  return typeof v === 'string' && (CLIENT_LOST_REASONS as readonly string[]).includes(v);
}

/** Человеку уходит сообщение только об отказе продавца. */
export function lostReasonTellsTourist(reason: LostReason): reason is DeclineReason {
  return isDeclineReason(reason);
}

/** Запись журнала заявки о закрытии продавцом (`lead_activity_log.action`). */
export const SELLER_CLOSED_ACTION = 'seller_closed';

/** Что продавец увидит до выбора: кому и что уйдёт. */
export const LOST_REASON_GROUPS = [
  {
    key: 'seller' as const,
    title: 'Отказываю я',
    note: 'Туристу уйдёт сообщение Ведара: что вы отказали и почему.',
    reasons: SELLER_LOST_REASONS,
  },
  {
    key: 'client' as const,
    title: 'Причина на стороне клиента',
    note: 'Туристу ничего не уйдёт. В статусе заявки он увидит причину с пометкой «по словам оператора».',
    reasons: CLIENT_LOST_REASONS,
  },
] as const;

/** Отказ без причины не принимается — словами для формы и API. */
export const LOST_REASON_REQUIRED = 'Укажите причину отказа: от неё зависит, что узнает турист.';
/** Причина не из списка. */
export const LOST_REASON_UNKNOWN = 'Причина отказа — одна из названных на экране.';
/** Причина пришла с другой отметкой: молча отбросить её значило бы принять то, чего не записали. */
export const LOST_REASON_ONLY_WITH_LOST = 'Причина отказа передаётся только вместе с отказом по заявке.';
/**
 * Причину называет продавец заявки. Администратор и оператор без карточки
 * партнёра закрывают заявку без неё: сообщение «оператор отказал» от них
 * было бы неправдой, а причина, принятая и нигде не записанная, — тоже.
 */
export const LOST_REASON_SELLER_ONLY = 'Причину отказа называет продавец заявки. Отсюда заявка закрывается без причины, и туристу ничего не уходит.';
