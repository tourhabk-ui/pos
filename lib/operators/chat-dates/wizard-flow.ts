/**
 * Даты кнопками в чате кабинета MAX (31.10): чьё нажатие и что показать.
 * Шаги — `wizard.ts`, предложение и запись — общие с фразой (`flow.ts`).
 *
 * Право — то же, что у фразы и у «Открыть»: продавец своих туров
 * (туроператор, гид с турами), с кабинетом, выключатель потока дат включён.
 * Тур — только из живых туров карточки чата: чужой id в кнопке ничего не
 * открывает (`tourGone`), а запись ещё раз сверяет тур по operator_id
 * (`pressOpen`). Личный диалог проверяет роут: в группе кнопку «Открыть»
 * нажал бы любой участник.
 */

import type { PartnerChatContext, PartnerChatLookup } from '@/lib/kuzmich/operator-chat';
import { sellsOwnTours } from '@/lib/partners/tour-seller';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { CHAT_OPEN_DATES_ENABLED } from './switch';
import { readPartnerTours } from './proposals';
import { type DatesSeller, FLOW_TEXT, datesSellerOf, wholeMonthHint } from './texts';
import { type DatesSend, proposeChosenDates } from './flow';
import {
  type WizardStep, WIZARD_TEXT, daysStep, dw, monthStep, parseWizardPayload, seatsStep, toursStep, wizardDates, wizardRule,
} from './wizard';

function gateText(partner: PartnerChatContext): string | null {
  const seller = datesSellerOf(partner);
  if (!CHAT_OPEN_DATES_ENABLED) return FLOW_TEXT.switchedOff(seller);
  if (!partner.userId) return FLOW_TEXT.noAccount(seller);
  return null;
}

/**
 * Первый экран «Обновить места»: выбор тура или, когда живой тур один, сразу
 * месяц. Строка про фразу — для числа мест, которого нет на кнопках.
 */
export async function datesWizardStart(partner: PartnerChatContext, nowMs: number): Promise<WizardStep> {
  const refused = gateText(partner);
  if (refused) return { text: refused, rows: [] };
  const seller = datesSellerOf(partner);
  const tours = await readPartnerTours(partner.partnerId);
  if (tours === null) return { text: FLOW_TEXT.toursUnread, rows: [] };
  const live = tours.filter((t) => t.active);
  if (live.length === 0) return { text: FLOW_TEXT.noTours(seller), rows: [] };
  const today = kamchatkaDate(new Date(nowMs));
  const step = live.length === 1 ? monthStep(live[0]!, today, false) : toursStep(tours);
  return { text: `${step.text}\nИли фразой, например ${wholeMonthHint(today)}.`, rows: step.rows };
}

/**
 * Нажатие `dw:`. `send` правит сообщение с кнопкой (не вышло — новое): весь
 * выбор живёт в одном сообщении, последним шагом оно становится предложением
 * с «Открыть» / «Не надо».
 */
export async function handleDatesWizardPress(opts: {
  payload: string;
  chatId: number;
  lookup: PartnerChatLookup;
  send: DatesSend;
  nowMs?: number;
}): Promise<void> {
  const { lookup, send } = opts;
  const seller: DatesSeller = lookup.outcome === 'found' ? datesSellerOf(lookup.partner) : 'operator';
  if (!CHAT_OPEN_DATES_ENABLED) { await send(FLOW_TEXT.switchedOff(seller)); return; }
  if (lookup.outcome === 'unavailable') { await send(FLOW_TEXT.pressUnverifiedPartner); return; }
  if (lookup.outcome === 'none' || !sellsOwnTours(lookup.partner)) { await send(FLOW_TEXT.pressNotHere); return; }
  const partner = lookup.partner;
  if (!partner.userId) { await send(FLOW_TEXT.noAccount(seller)); return; }
  const press = parseWizardPayload(opts.payload);
  if (!press) { await send(WIZARD_TEXT.badButton); return; }
  const nowMs = opts.nowMs ?? Date.now();

  if (press.step === 'cancel') { await send(WIZARD_TEXT.cancelled); return; }
  if (press.step === 'tours') {
    const start = await datesWizardStart(partner, nowMs);
    await send(start.text, start.rows);
    return;
  }

  const tours = await readPartnerTours(partner.partnerId);
  if (tours === null) { await send(FLOW_TEXT.toursUnread); return; }
  const live = tours.filter((t) => t.active);
  const tour = live.find((t) => t.id === press.tourId);
  if (!tour) {
    await send(WIZARD_TEXT.tourGone, live.length > 0 ? [[{ text: '‹ Тур', payload: dw.tours() }]] : undefined);
    return;
  }
  const today = kamchatkaDate(new Date(nowMs));
  switch (press.step) {
    case 'month': {
      const step = monthStep(tour, today, live.length > 1);
      await send(step.text, step.rows);
      return;
    }
    case 'days': {
      const step = daysStep(tour, press.month, today);
      await send(step.text, step.rows);
      return;
    }
    case 'seats': {
      // Пока выбирали места, дни могли пройти: такой шаг — снова выбор дней.
      const step = wizardDates(press.month, press.pattern, today).length > 0
        ? seatsStep(tour, press.month, press.pattern, today)
        : daysStep(tour, press.month, today);
      await send(step.text, step.rows);
      return;
    }
    case 'go': {
      const dates = wizardDates(press.month, press.pattern, today);
      if (dates.length === 0) {
        await send(WIZARD_TEXT.noDatesLeft(press.month, press.pattern), [[{ text: '‹ Месяц', payload: dw.month(tour.id) }]]);
        return;
      }
      await proposeChosenDates({
        chatId: opts.chatId,
        partner,
        tours,
        tourId: tour.id,
        dates,
        seats: press.seats,
        rule: wizardRule(press.month, press.pattern),
        weekdayWords: press.pattern !== 'a',
        send,
        nowMs,
      });
    }
  }
}
