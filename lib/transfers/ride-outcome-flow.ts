/**
 * Исход поездки по заявке на машину — от перевозчика (#2862 этап B, 30.10):
 * одно правило для кнопки в MAX и Telegram (под вопросом «Поездка
 * состоялась?» в карточке «Входящих» кабинета в чате) и для кабинета на
 * сайте.
 *
 * Порядок: заявка его и это заявка на машину → на неё был ответ «Беру»
 * (иначе подтверждать нечем) → поездка закончилась по Камчатке → исход
 * пишется в журнал лида ОДИН раз (lead_activity_log.ride_outcome,
 * уникальный индекс 1353; второе нажатие видит записанный). Дальше, каждое
 * само по себе и с логом при отказе:
 *   · «состоялась» — ссылка на отзыв тем же путём, что выдаёт менеджер
 *     (issueCharterInvite, подтвердил — перевозчик), заказчику в переписку
 *     заявки (1350); лид → converted;
 *   · «не состоялась» — лид → lost;
 *   · менеджеру Ведара — факт без ПД; не дошедшую до заказчика ссылку
 *     передаёт он.
 * Машина заявкой по-прежнему не закрепляется, суммы нет (§14): исход — слово
 * перевозчика о факте, записанное с его именем.
 */

import { getPublicBaseUrl } from '@/lib/config';
import { pool } from '@/lib/db-pool';
import { tgSend } from '@/lib/notifications/tg-send';
import { changeLeadStatus } from '@/lib/leads/owner-lead-status';
import { postOwnerMessage } from '@/lib/requests/request-chat-service';
import { isChatTargetId } from '@/lib/requests/request-chat';
import { requestAnswerEditText, type ClientTold } from '@/lib/rental/request-answer';
import type { AnswerActor, AnswerLookup, AnswerSend } from '@/lib/rental/request-answer-flow';
import { loadOwnedRentalRequest, readPartnerAnswer, type OwnedRentalRequest } from '@/lib/rental/request-answer-store';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { carrierReviewInviteUrl } from '@/lib/transfers/carrier-review-rules';
import { issueCharterInvite } from '@/lib/transfers/carrier-reviews';
import {
  clientRideHeldText, managerRideText, parseRideOutcomePress, rideEnded, rideTellText,
  type RideOutcome, type RideTell,
} from '@/lib/transfers/ride-outcome';
import type { OwnerStatusVia } from '@/lib/bookings/owner-status';

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет';
}

async function tellManager(text: string): Promise<void> {
  const sent = await tgSend('charter-ride-outcome', text);
  if (!sent.ok) console.error(`[charter-ride-outcome] менеджеру не доставлено: ${sent.reason}`);
}

/** Прежний исход по заявке; 'none' — не записан; 'db_error' — не прочитан. */
async function readOutcome(leadId: string): Promise<RideOutcome | 'none' | 'db_error'> {
  try {
    const { rows } = await pool.query<{ outcome: string | null }>(
      `SELECT details->>'outcome' AS outcome FROM lead_activity_log
        WHERE lead_id = $1::uuid AND action = 'ride_outcome' ORDER BY id DESC LIMIT 1`,
      [leadId],
    );
    const o = rows[0]?.outcome;
    return o === 'held' || o === 'not_held' ? o : 'none';
  } catch (err) {
    console.error('[charter-ride-outcome] исход не прочитан, SQLSTATE', sqlstate(err));
    return 'db_error';
  }
}

type Claim = { outcome: 'saved' } | { outcome: 'already'; prior: RideOutcome } | { outcome: 'db_error' };

/** Одна запись на заявку: уникальный индекс решает гонку двух нажатий. */
async function claimOutcome(req: OwnedRentalRequest, outcome: RideOutcome, now: Date): Promise<Claim> {
  try {
    await pool.query(
      `INSERT INTO lead_activity_log (lead_id, actor, action, details)
       VALUES ($1::uuid, 'partner', 'ride_outcome', $2::jsonb)`,
      [req.leadId, JSON.stringify({
        outcome, kind: 'charter', at: now.toISOString(),
        destination: req.title, date_from: req.dateFrom, date_to: req.dateTo,
      })],
    );
    return { outcome: 'saved' };
  } catch (err) {
    if (sqlstate(err) === '23505') {
      const prior = await readOutcome(req.leadId);
      if (prior === 'held' || prior === 'not_held') return { outcome: 'already', prior };
    }
    console.error('[charter-ride-outcome] исход не записан, SQLSTATE', sqlstate(err));
    return { outcome: 'db_error' };
  }
}

async function markLead(partner: AnswerActor, leadId: string, outcome: RideOutcome, via: OwnerStatusVia): Promise<void> {
  try {
    const r = await changeLeadStatus({
      leadId,
      status: outcome === 'held' ? 'converted' : 'lost',
      actor: { kind: 'partner_user', userId: partner.userId ?? null },
      scope: { kind: 'owner', partnerId: partner.partnerId, claimUnowned: false },
      via,
    });
    if (r.kind === 'not_found') console.error(`[charter-ride-outcome] статус заявки ${leadId} не сменён: заявка не в скоупе перевозчика`);
  } catch (err) {
    console.error('[charter-ride-outcome] статус заявки не сменён, SQLSTATE', sqlstate(err));
  }
}

const INVITE_PROBLEM: Record<'not_found' | 'no_date' | 'not_yet' | 'already_reviewed', string> = {
  not_found: 'заявка не найдена среди заявок перевозчика',
  no_date: 'в заявке нет даты выезда',
  not_yet: 'дата выезда ещё не наступила',
  already_reviewed: 'отзыв по этой поездке уже оставлен',
};

export interface RideOutcomeDeps {
  now?: Date;
  notifyManager?: (text: string) => Promise<void>;
}

/**
 * Записать исход поездки — для кнопки в чате и для двери сайта. Заявка
 * обязана быть его, с ответом «Беру» и уже закончившейся поездкой.
 */
export async function recordRideOutcome(opts: {
  partner: AnswerActor;
  leadId: string;
  outcome: RideOutcome;
  via: OwnerStatusVia;
} & RideOutcomeDeps): Promise<{ tell: RideTell; request: OwnedRentalRequest | null }> {
  const now = opts.now ?? new Date();
  const notify = opts.notifyManager ?? tellManager;
  const partner = opts.partner;

  const loaded = await loadOwnedRentalRequest(partner.partnerId, opts.leadId);
  if (loaded.outcome !== 'ok') {
    const kind = loaded.outcome === 'missing' ? 'missing' as const
      : loaded.outcome === 'db_error' ? 'unread' as const
      : 'not_yours' as const;
    return { tell: { kind }, request: null };
  }
  const request = loaded.request;
  if (request.kind !== 'charter') return { tell: { kind: 'not_yours' }, request: null };

  const answer = await readPartnerAnswer(request.leadId);
  if (answer === 'db_error') return { tell: { kind: 'unread' }, request };
  if (answer !== 'take') return { tell: { kind: 'not_taken' }, request };

  const today = kamchatkaToday(now.getTime());
  const ended = rideEnded(request.dateFrom, request.dateTo, today);
  if (ended !== true) return { tell: { kind: 'not_yet', lastDay: ended === null ? null : (request.dateTo ?? request.dateFrom) }, request };

  const claimed = await claimOutcome(request, opts.outcome, now);
  if (claimed.outcome === 'db_error') return { tell: { kind: 'retry' }, request };
  if (claimed.outcome === 'already') return { tell: { kind: 'already', outcome: claimed.prior }, request };

  await markLead(partner, request.leadId, opts.outcome, opts.via);

  let tell: RideTell;
  let forwardUrl: string | null = null;
  if (opts.outcome === 'not_held') {
    tell = { kind: 'not_held' };
  } else {
    let linkIssued = false;
    let linkProblem: string | null = null;
    let clientTold: ClientTold = null;
    try {
      const r = await issueCharterInvite({
        leadId: request.leadId, confirmedBy: null, today, now: now.getTime(),
        confirmedByKind: 'carrier', confirmedPartnerId: partner.partnerId,
      });
      if (r.ok) {
        linkIssued = true;
        const url = carrierReviewInviteUrl(getPublicBaseUrl(), r.slug, r.key);
        clientTold = await tellClient(partner, request.leadId, url);
        if (clientTold !== true) forwardUrl = url;
      } else {
        linkProblem = INVITE_PROBLEM[r.reason];
      }
    } catch (err) {
      console.error('[charter-ride-outcome] ссылка на отзыв не выдана, SQLSTATE', sqlstate(err));
      linkProblem = 'база не ответила при выдаче ссылки';
    }
    tell = { kind: 'held', clientTold, linkIssued, linkProblem };
  }

  try {
    await notify(managerRideText({
      partnerName: partner.partnerName, leadId: request.leadId, outcome: opts.outcome,
      destination: request.title, dateFrom: request.dateFrom, dateTo: request.dateTo, forwardUrl,
    }));
  } catch (err) {
    console.error('[charter-ride-outcome] менеджеру не доставлено:', err instanceof Error ? err.message : err);
  }
  return { tell, request };
}

/** Заказчику — ссылка в переписку заявки. true/false — записана и видна / нет; null — переписки у заявки нет. */
async function tellClient(partner: AnswerActor, leadId: string, url: string): Promise<ClientTold> {
  if (!isChatTargetId(leadId)) return null;
  try {
    const r = await postOwnerMessage({ kind: 'lead', id: leadId }, clientRideHeldText(partner.partnerName, url));
    if (r.outcome === 'sent') return r.pageVisible !== false;
    console.error(`[charter-ride-outcome] заказчику по заявке ${leadId} ссылка не передана: ${r.outcome}`);
    return false;
  } catch (err) {
    console.error('[charter-ride-outcome] заказчику ссылка не передана:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Исход, после которого сообщение с кнопками правится. */
const EDITS: ReadonlySet<RideTell['kind']> = new Set(['held', 'not_held', 'already']);

/** Нажатие `rc:` в чате — MAX и Telegram. Ответ правит сообщение с кнопками или идёт новым. */
export async function handleRideOutcomePress(opts: {
  lookup: AnswerLookup;
  payload: string;
  editMid: string | null;
  originalText: string | null;
  send: AnswerSend;
  via: OwnerStatusVia;
} & RideOutcomeDeps): Promise<void> {
  const say = async (tell: RideTell, edit: boolean) => {
    const line = rideTellText(tell);
    await opts.send(edit ? requestAnswerEditText(opts.originalText, line) : line, edit ? opts.editMid : null);
  };
  const press = parseRideOutcomePress(opts.payload);
  if (!press) return say({ kind: 'unparsed' }, false);
  if (opts.lookup.outcome === 'unavailable') return say({ kind: 'unread' }, false);
  if (opts.lookup.outcome !== 'found') return say({ kind: 'not_yours' }, false);
  const { tell } = await recordRideOutcome({
    partner: opts.lookup.partner, leadId: press.leadId, outcome: press.outcome, via: opts.via,
    now: opts.now, notifyManager: opts.notifyManager,
  });
  await say(tell, EDITS.has(tell.kind));
}
