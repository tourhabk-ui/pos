/**
 * lib/mcp/pending-confirm.ts — человек нажал «Отправить» на /confirm
 * (#3399, п. 4; слово владельца 15.11 «Делай»).
 *
 * Заявка забирается из отложенных один раз (аргументы стираются в том же
 * запросе), сверяется ревизия плана (правка плана после черновика — отправки
 * нет: человек видел другое), и заявка уходит тем же исполнителем, что у MCP,
 * с согласием, данным человеком на странице (`sentByHuman`). Ответ человеку —
 * тем же правилом, что в чате Кузьмича (chatToolReply): «создана» — только
 * по признаку успеха исполнителя.
 */
import { claimPendingRequest, releasePendingRequest } from '@/lib/mcp/pending-request';
import { runPublicTool, planRevisionOf } from '@/app/api/mcp/route';
import { chatToolReply, chatRequestUnconfirmed } from '@/lib/kuzmich/chat-request';
import type { PdConsentPurpose } from '@/lib/legal/pd-consent';

export type PendingSendOutcome =
  | { kind: 'sent'; created: boolean; text: string }
  | { kind: 'gone' }
  | { kind: 'plan_changed' }
  /** Не дошла по временной причине (лимит, сбой базы) — заявка снова ждёт. */
  | { kind: 'retry'; text: string }
  | { kind: 'failed' };

export const PENDING_GONE_TEXT =
  'Эта заявка уже отправлена или ссылка истекла. Если заявку не отправляли, попросите помощника собрать её заново — придёт новая ссылка.';
export const PENDING_PLAN_CHANGED_TEXT =
  'План поездки изменился после того, как помощник подготовил заявку, — отправлять её на прежние данные нельзя. Попросите помощника собрать заявку заново.';
export const PENDING_RATE_LIMITED_TEXT =
  'Слишком много заявок с этого адреса за час — эта заявка не отправлена, но ещё ждёт. Нажмите «Отправить» позже по той же ссылке.';
export const PENDING_FAILED_TEXT =
  'Не удалось отправить заявку: база Ведара не ответила. Попробуйте через минуту — заявка ещё ждёт.';

/**
 * `ip` — ключ лимита записи (всегда строка); `consentIp` — адрес, который
 * ляжет в запись согласия: null, если прокси его не прислал (без выдуманного
 * 127.0.0.1, ревью #3418).
 */
export async function sendPendingRequest(token: string, from: { ip: string; consentIp: string | null; userAgent: string }): Promise<PendingSendOutcome> {
  const claim = await claimPendingRequest(token);
  if (claim.kind === 'gone') return { kind: 'gone' };
  if (claim.kind === 'failed') return { kind: 'failed' };
  const planId = typeof claim.args.plan_id === 'string' ? claim.args.plan_id.trim() : '';
  if (planId && claim.planRevision !== null && (await planRevisionOf(planId)) !== claim.planRevision) {
    return { kind: 'plan_changed' };
  }
  try {
    const out = await runPublicTool({
      toolName: claim.tool,
      rawArguments: { ...claim.args, consent: true },
      ip: from.ip,
      userAgent: from.userAgent.slice(0, 200),
      self: false,
      sentByHuman: { ip: from.consentIp },
      ...(claim.via === 'a2a' ? { via: 'a2a' as const } : {}),
    });
    // Лимит — временный и наступает до исполнителя, то есть до записи: заявка
    // возвращается в ожидание. Сбой исполнителя ('failed') — нет: дошла ли
    // запись, неизвестно, и повтор мог бы её задвоить (ревью #3418).
    if (out.kind === 'rate_limited') {
      const back = await releasePendingRequest(token, claim.args);
      if (back) return { kind: 'retry', text: PENDING_RATE_LIMITED_TEXT };
    }
    const reply = chatToolReply(out);
    return { kind: 'sent', created: reply.created, text: reply.text };
  } catch (err) {
    // Исключение после того, как заявка забрана: дошла ли запись, неизвестно —
    // в ожидание не возвращаем (второе нажатие могло бы её задвоить), честно
    // говорим «не могу подтвердить».
    console.error('[mcp-pending] отправка упала после того, как заявка забрана:', err instanceof Error ? err.message.slice(0, 200) : 'неизвестно');
    return { kind: 'sent', created: false, text: chatRequestUnconfirmed() };
  }
}

/**
 * Чьи тексты согласия человек видит на странице — те же, что запишутся
 * (lib/legal/pd-consent): у поездки целиком — по части, каждой свой адресат.
 */
export function consentPurposesForTool(tool: string, args: { tour?: unknown; stay?: unknown; stay_wanted?: unknown; transfer_destination?: unknown; carrier?: unknown }): PdConsentPurpose[] {
  switch (tool) {
    case 'create_booking_request': return ['operator'];
    case 'create_lead': return ['operators'];
    case 'create_stay_request': return ['stay'];
    case 'request_charter': return ['carrier'];
    case 'create_car_rental_request': return ['rental'];
    case 'create_trip_request': {
      const out: PdConsentPurpose[] = [];
      if (args.tour) out.push('operator');
      if (args.stay) out.push('stay');
      // Машина с названным перевозчиком — ему; без перевозчика и жильё на подбор — менеджеру и партнёрам.
      if (args.transfer_destination && args.carrier) out.push('carrier');
      if ((args.transfer_destination && !args.carrier) || args.stay_wanted) out.push('operators');
      return out.length ? out : ['operators'];
    }
    default: return ['operator'];
  }
}
