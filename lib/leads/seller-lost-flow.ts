/**
 * lib/leads/seller-lost-flow.ts — «Отказ» с причиной из кабинета на сайте:
 * запись и отправка сообщения человеку (план «после отказа», этап 3а).
 *
 * Одна на кабинет оператора (`PATCH /api/leads/[id]`) и раздел «Свои туры»
 * гида (`PATCH /api/guide/own/leads/[id]`). Запись — changeLeadStatus: статус,
 * причина, журнал и строка сообщения одним запросом. Здесь — отправка той
 * строки и слова продавцу о том, что на деле ушло человеку: «туристу
 * сообщено» говорится только по исходу отправки, а не по факту нажатия.
 *
 * Отправка ждёт не дольше срока нажатия (press-budget): зависший канал не
 * держит форму, исход допишется в строку сообщения, обрыв подберёт добивка.
 *
 * После отказа продавца Ведар спрашивает другие компании с турами к тому же
 * месту, возьмут ли они человека на эту дату (этап 4б, lib/requests/offer-asks)
 * — без его имени и телефона; продавцу об этом сказано строкой.
 */
import { changeLeadStatus, type LeadChangeResult } from '@/lib/leads/owner-lead-status';
import { lostReasonTellsTourist, type LostReason } from '@/lib/leads/lost-reason';
import type { OwnerStatusVia } from '@/lib/bookings/owner-status';
import type { LeadScope } from '@/lib/leads/ownership';
import { withinPress } from '@/lib/requests/press-budget';
import { operatorOutcomeLine, type NoticeOutcome } from '@/lib/requests/answer-notice-text';

/** Продавцу: причина на стороне клиента — человеку ничего не ушло, и почему. */
export const CLIENT_REASON_LINE = 'Туристу ничего не отправлено: причина на стороне клиента. В статусе заявки он увидит её с пометкой «по словам оператора».';
/** Заявка была ничейной: человек её этому продавцу не слал. */
export const NOT_ADDRESSED_LINE = 'Заявка не была адресована вам — туристу ничего не отправлено.';
/** Заявка на машину или прокат: об отказе по ним человеку сообщает ответ «Не могу», не эта отметка. */
export const NO_NOTICE_KIND_LINE = 'Туристу ничего не отправлено: по заявке этого вида сообщение об отказе отсюда не уходит.';

export interface SellerLostResult {
  outcome: LeadChangeResult;
  /**
   * Что на деле ушло человеку — строкой для продавца. null — отказ с причиной
   * этим запросом не записан (заявка не найдена, уже закрыта, отменена клиентом).
   */
  touristLine: string | null;
}

export interface SellerLostDeps {
  change?: typeof changeLeadStatus;
  deliver?: (noticeId: string) => Promise<NoticeOutcome>;
  /** Вопрос другим компаниям после отказа (этап 4б): строка продавцу о дошедших вопросах или null. */
  ask?: (leadId: string) => Promise<string | null>;
}

export async function closeLeadWithReason(args: {
  leadId: string;
  reason: LostReason;
  notes?: string;
  actor: { kind: 'admin' | 'partner_user'; userId: string | null };
  scope: Extract<LeadScope, { kind: 'owner' }>;
  via: OwnerStatusVia;
}, deps: SellerLostDeps = {}): Promise<SellerLostResult> {
  const change = deps.change ?? changeLeadStatus;
  const outcome = await change({
    leadId: args.leadId, status: 'lost', notes: args.notes, actor: args.actor, scope: args.scope, via: args.via,
    lost: { reason: args.reason, partnerId: args.scope.partnerId },
  });
  if (outcome.kind !== 'ok' || !outcome.closed) return { outcome, touristLine: null };

  const notice = outcome.closed.notice;
  if (!notice) {
    return { outcome, touristLine: lostReasonTellsTourist(args.reason) ? NO_NOTICE_KIND_LINE : CLIENT_REASON_LINE };
  }
  if (notice.state === 'skipped') {
    if (notice.skipped === 'not_addressee') return { outcome, touristLine: NOT_ADDRESSED_LINE };
    const reason = notice.skipped === 'self' || notice.skipped === 'lead_closed' ? notice.skipped : 'outgrown';
    return { outcome, touristLine: operatorOutcomeLine({ state: 'skipped', reason }) };
  }
  const deliver = deps.deliver ?? (async (id: string) => (await import('@/lib/requests/answer-notice')).deliverAnswerNotice(id));
  // Вопрос другим компаниям (4б) идёт рядом с сообщением человеку, со своим, более
  // коротким сроком: форма ждёт не дольше прежнего. Когда спрашивать, решает сам
  // вопрос (тот же вид заявки, что «назвать других»).
  const ask = deps.ask ?? (async (id: string) => (await import('@/lib/requests/offer-asks')).askOtherCompaniesWithinPress(id));
  const [sent, asked] = await Promise.all([
    withinPress<NoticeOutcome>(deliver(notice.id), { state: 'pending', sending: true }),
    // Сбой вопросов закрытие заявки и сообщение человеку не отменяет: строки о них просто нет.
    ask(args.leadId).catch((err: unknown) => {
      console.error('[seller-lost-flow] вопрос другим компаниям не задан', err instanceof Error ? err.name : 'ошибка');
      return null;
    }),
  ]);
  return { outcome, touristLine: [operatorOutcomeLine(sent), asked].filter(Boolean).join(' ') };
}
