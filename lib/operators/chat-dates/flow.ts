/**
 * «Открой даты словами» в чате кабинета оператора в MAX (решение владельца
 * 22.10, вариант а; спецификация, этап C, §3 и §7). Поток: фраза → разбор
 * правилами → предложение с кнопками «Открыть» / «Не надо» → нажатие →
 * запись той же функцией, что у кабинета → исход по каждой дате словами.
 *
 * Роут MAX (`app/api/max/kuzmich`) зовёт сюда:
 *   - текст из чата партнёра (найден `findPartnerByChat`) по заверенному
 *     апдейту — `handleOperatorDatesText`. Не про даты — `false`, и
 *     сообщение идёт помощнику кабинета, как раньше. Из группы фраза про
 *     даты не пропадает молча (четвёртый ревью 22.10): ответ «даты — в
 *     личном диалоге», без предложения — в группе кнопку «Открыть» нажал бы
 *     любой участник;
 *   - нажатие кнопки `od:` по заверенному апдейту, чат — из сообщения с
 *     кнопкой, диалог, — `handleOperatorDatesPress`.
 * Незаверенное сюда не доходит: проверка `verifiedOrigin` — в роуте, одна на
 * все действия (lib/max/verified-press).
 *
 * Право чата (решения владельца 22.10):
 *   - только туроператор, и только компания с аккаунтом (`partners.user_id`):
 *     записи без кабинета даты из чата не открывают. Гид, перевозчик,
 *     владелец жилья — их сообщение уходит помощнику кабинета, как до этапа
 *     C (четвёртый ревью: готовый отказ «это для туроператора» отнимал у них
 *     помощника на любой фразе с «открой» и датой); помощник даты не меняет
 *     и об этом знает (lib/kuzmich/operator-chat, `partnerSystemPrompt`);
 *   - даты и места — да, цена — нет ни при каких правах;
 *   - закрытые оператором даты и даты вне сезона тура не открываются: строка
 *     предложения называет их и ведёт в кабинет;
 *   - один чат на две компании — старшая запись, как у `findPartnerByChat`.
 *
 * Модели здесь нет (этап D не делается): непонятая фраза — «Не понял» с
 * примером. Сырая фраза не уходит ни в историю помощника, ни в лог.
 *
 * Поправка текстом гасит предложение (четвёртый ревью 22.10): любой ответ
 * потока на новую фразу — отказ, вопрос, «туры не прочитались» — снимает
 * действующее предложение чата (`superseded`), «отмена», «стоп», «не надо» —
 * отменяет (`cancelled`). Старая кнопка «Открыть» после этого не пишет.
 *
 * Повтор старого апдейта MAX (шестой ревью): у каждого снятия и замены —
 * время сообщения по часам MAX (`sentAtMs`); предложение, заведённое позже
 * этого сообщения, оно не снимает и не заменяет.
 *
 * Сторожа: tests/unit/chat-open-dates-max.test.ts (роут целиком),
 * tests/integration/chat-open-dates.pg.test.ts (путь записи).
 */

import type { PartnerChatContext, PartnerChatLookup } from '@/lib/kuzmich/operator-chat';
import { saveMsg } from '@/lib/kuzmich/core';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { CHAT_OPEN_DATES_ENABLED } from './switch';
import {
  type ChatTour, type DatesProposal, chatDatesIntent, correctionSign, mentionsTour, parseDatesPhrase, seatsReply,
} from './parse';
import {
  type PressBlocked, type ProposalState, chatOpenInput, createProposal, draftWaiting, fillDraftSeats, pressCancel, pressOpen,
  pressTour, previewDates, readAutoConfirm, readPartnerTours, retireActive,
} from './proposals';
import {
  FLOW_TEXT, type PastFlags, askSeatsText, askText, chooseTourText, historyAsk, historyResult, outcomeText, proposalFits,
  proposalText, refusalText, repeatText, tourButtonText,
} from './texts';

export interface DatesButton {
  text: string;
  payload: string;
  intent?: 'positive' | 'negative';
}
/** Ответ в чат кабинета: текст и, если есть, кнопки (каждый ряд — массив). */
export type DatesSend = (text: string, buttons?: DatesButton[][]) => Promise<void>;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OD_RE = new RegExp(`^od:(o|x):(${UUID})$`);
const OD_TOUR_RE = new RegExp(`^od:t:(${UUID}):([0-7])$`);

/** Кнопки предложения. payload — только id строки (и индекс тура): ни ПД, ни id тура. */
export const odOpen = (id: string): string => `od:o:${id}`;
export const odCancel = (id: string): string => `od:x:${id}`;
export const odTour = (id: string, index: number): string => `od:t:${id}:${index}`;

export type OdPress =
  | { action: 'open' | 'cancel'; id: string }
  | { action: 'tour'; id: string; index: number };

export function parseOdPayload(payload: string): OdPress | null {
  const m = payload.match(OD_RE);
  if (m) return { action: m[1] === 'o' ? 'open' : 'cancel', id: m[2]! };
  const t = payload.match(OD_TOUR_RE);
  if (t) return { action: 'tour', id: t[1]!, index: Number(t[2]) };
  return null;
}

/** Почему чат туроператора не открывает даты; null — открывает. Не туроператор сюда не доходит. */
function gate(partner: PartnerChatContext): string | null {
  if (!CHAT_OPEN_DATES_ENABLED) return FLOW_TEXT.switchedOff();
  if (!partner.userId) return FLOW_TEXT.noAccount();
  return null;
}

/**
 * Ответ потока на фразу без нового предложения (отказ, вопрос): прежнее
 * предложение чата снимается — поправка словами не оставляет живой старую
 * кнопку «Открыть». Не снялось — так и сказано.
 */
async function answerRetiring(chatId: number, send: DatesSend, text: string, sentAtMs: number | null): Promise<void> {
  const retired = await retireActive(chatId, 'superseded', sentAtMs);
  await send(retired === null ? `${text}\n${FLOW_TEXT.retireFailed}` : text);
}

const cancelRow = (id: string): DatesButton[] => [{ text: 'Не надо', payload: odCancel(id), intent: 'negative' }];

// ── Текст ─────────────────────────────────────────────────────────────────

interface TextOpts {
  chatId: number;
  sourceMid: string | null;
  text: string;
  partner: PartnerChatContext;
  send: DatesSend;
  /** Личный диалог с ботом; false — группа: предложения там нет. По умолчанию — диалог. */
  dialog?: boolean;
  nowMs?: number;
  /**
   * Время сообщения по часам MAX (мс, `timestamp` апдейта): повтор старого
   * сообщения не снимает и не заменяет предложение новее него (шестой ревью).
   */
  sentAtMs?: number | null;
}

/**
 * Сообщение партнёра в чате кабинета. `true` — обработано здесь (ответ ушёл),
 * `false` — не про даты, сообщение идёт помощнику кабинета.
 *
 * Поправка, ушедшая помощнику (пятый ревью 22.10: «нет, 4 места», «не 8, а
 * 4», «не тот тур», «ой, не 5, а 6 августа», голое «4» при готовом
 * предложении), тоже снимает действующее предложение туроператора в
 * диалоге: старая «Открыть» не должна жить 30 минут рядом с поправкой.
 * Признак поправки — цифры, слово даты, «мест», «не»/«нет» или слово тура.
 */
export async function handleOperatorDatesText(opts: TextOpts): Promise<boolean> {
  const handled = await handleText(opts);
  if (handled) return true;
  const { partner, chatId, send } = opts;
  if (partner.category !== 'operator' || (opts.dialog ?? true) !== true || gate(partner) !== null) return false;
  if (chatDatesIntent(opts.text, opts.nowMs ?? Date.now()) === 'cancel') return false;
  let sign = correctionSign(opts.text);
  if (!sign) {
    const tours = await readPartnerTours(partner.partnerId);
    sign = tours !== null && mentionsTour(opts.text, tours);
  }
  if (!sign) return false;
  const n = await retireActive(chatId, 'superseded', opts.sentAtMs ?? null);
  if (n === null) await send(FLOW_TEXT.retireFailed);
  else if (n > 0) await send(FLOW_TEXT.retiredByCorrection);
  return false;
}

async function handleText(opts: TextOpts): Promise<boolean> {
  const { chatId, partner, send } = opts;
  const dialog = opts.dialog ?? true;
  const nowMs = opts.nowMs ?? Date.now();
  // Гид, перевозчик, владелец жилья — помощнику кабинета, как до этапа C.
  if (partner.category !== 'operator') return false;
  // Только фраза, где даты — предмет (шапка parse.ts, «Чьё это сообщение»):
  // задача, касание, счёт с датой уходят помощнику кабинета, а не сюда.
  const intent = chatDatesIntent(opts.text, nowMs);
  if (intent === null) return false;

  if (intent === 'seats') {
    // Голое число — про места, только если черновик в этом чате их ждёт;
    // иначе это разговор с помощником.
    if (!dialog || gate(partner) !== null) return false;
    return answerSeats(chatId, opts.sourceMid, partner, seatsReply(opts.text), send, nowMs, opts.sentAtMs ?? null);
  }

  if (intent === 'cancel') {
    // «отмена», «стоп», «не надо»: есть действующее предложение — снять его;
    // нет — это разговор с помощником.
    if (!dialog || gate(partner) !== null) return false;
    const n = await retireActive(chatId, 'cancelled', opts.sentAtMs ?? null);
    if (n === 0) return false;
    await send(n === null ? FLOW_TEXT.cancelFailed : FLOW_TEXT.cancelledByText);
    return true;
  }

  // Отказ гейта (нет кабинета, выключатель) отвечает только на явную просьбу
  // о датах тура. Предмет, который может оказаться туром («Выставь Горелый на
  // 5 августа»), сначала сверяется с турами: «Открой расписание на июль» —
  // дело помощника, а не отказ гейта.
  const strict = chatDatesIntent(opts.text, nowMs, true) === 'dates';
  const refused = gate(partner);
  if (refused && strict) {
    await send(refused);
    return true;
  }

  const tours = await readPartnerTours(partner.partnerId);
  const parsed = parseDatesPhrase(opts.text, nowMs, tours);
  if (parsed.kind === 'not_dates') return false;
  if (refused) {
    await send(refused);
    return true;
  }
  if (!dialog) {
    await send(FLOW_TEXT.groupChat);
    return true;
  }
  const today = kamchatkaDate(new Date(nowMs));
  const sentAt = opts.sentAtMs ?? null;
  switch (parsed.kind) {
    case 'close_intent': await answerRetiring(chatId, send, FLOW_TEXT.closeIntent(), sentAt); return true;
    case 'ask': await answerRetiring(chatId, send, askText(parsed, today), sentAt); return true;
    case 'refused': await answerRetiring(chatId, send, refusalText(parsed, today), sentAt); return true;
    case 'proposal': await onProposal(chatId, opts.sourceMid, partner, parsed, tours ?? [], send, nowMs, sentAt); return true;
  }
}

/**
 * Telegram: фраза про даты туроператора отвечает «это в MAX», дело
 * помощника — помощнику. Решает тот же разбор с прочитанными турами, что в
 * MAX: «Выставь Горелый на 5 августа» — даты, «Открой расписание на июль» —
 * помощнику (пятый ревью 22.10).
 */
export async function isOperatorDatesPhrase(text: string, partnerId: string, nowMs: number = Date.now()): Promise<boolean> {
  if (chatDatesIntent(text, nowMs) !== 'dates') return false;
  const tours = await readPartnerTours(partnerId);
  return parseDatesPhrase(text, nowMs, tours).kind !== 'not_dates';
}

async function onProposal(
  chatId: number, sourceMid: string | null, partner: PartnerChatContext, p: DatesProposal,
  tours: ChatTour[], send: DatesSend, nowMs: number, sentAtMs: number | null,
): Promise<void> {
  const flags = {
    priceMentioned: p.priceMentioned, weekdayWords: p.weekdayWords, pastDropped: p.pastDropped, pastNamed: p.pastNamed,
    today: kamchatkaDate(new Date(nowMs)), rule: p.rule,
  };
  switch (p.tour.kind) {
    case 'unread': await answerRetiring(chatId, send, FLOW_TEXT.toursUnread, sentAtMs); return;
    case 'no_tours': await answerRetiring(chatId, send, FLOW_TEXT.noTours(), sentAtMs); return;
    case 'name_needed':
      await answerRetiring(chatId, send, FLOW_TEXT.nameNeeded(tours.filter((t) => t.active).map((t) => t.title)), sentAtMs);
      return;
    case 'hidden': await answerRetiring(chatId, send, FLOW_TEXT.hiddenTours(p.tour.titles), sentAtMs); return;
    case 'choose':
    case 'one':
      break;
  }
  // Список дат под кнопкой не режется: не влезает — «разбейте» (§5 четвёртого ревью).
  if (!proposalFits(p.dates, p.rule)) {
    await answerRetiring(chatId, send, FLOW_TEXT.tooLong(p.dates.length), sentAtMs);
    return;
  }
  const tourId = p.tour.kind === 'one' ? p.tour.id : null;
  const candidateIds = p.tour.kind === 'choose' ? p.tour.ids : null;
  const created = await createProposal({
    partnerId: partner.partnerId, chatId, sourceMid, tourId, candidateIds, dates: p.dates, seats: p.seats,
    priceMentioned: p.priceMentioned, weekdayWords: p.weekdayWords, rule: p.rule, sentAtMs,
  });
  if (created.kind === 'duplicate_mid') return;
  if (created.kind === 'stale') { await send(FLOW_TEXT.staleMessage); return; }
  if (created.kind === 'failed') { await send(FLOW_TEXT.saveFailed); return; }
  const id = created.id;
  const title = (tid: string) => tours.find((t) => t.id === tid)?.title ?? `тур ${tid}`;

  if (created.kind === 'created') {
    await saveMsg(chatId, 'operator_tg', 'user', historyAsk(tourId ? title(tourId) : null, p.dates, p.seats));
  }
  if (candidateIds) {
    await sendChoose(send, id, p.dates, p.seats, candidateIds.map(title), flags, p.tour.kind === 'choose' ? p.tour.hidden : undefined);
    return;
  }
  if (p.seats === null) {
    await send(askSeatsText({ tourTitle: title(tourId!), dates: p.dates, ...flags }), [cancelRow(id)]);
    return;
  }
  await sendProposal(send, partner, id, tourId!, p.dates, p.seats, title(tourId!), flags, nowMs);
}

async function sendChoose(
  send: DatesSend, id: string, dates: string[], seats: number | null, titles: string[],
  flags: PastFlags & { priceMentioned: boolean; weekdayWords: boolean; rule: string | null }, hidden?: string[],
): Promise<void> {
  await send(
    chooseTourText({ dates, seats, titles, ...flags, hidden }),
    [...titles.map((t, i) => [{ text: tourButtonText(i, t), payload: odTour(id, i) }]), cancelRow(id)],
  );
}

/** Превью и вопрос «Открыть?»: кнопка «Открыть» — только если есть что открыть или превью не прочиталось. */
async function sendProposal(
  send: DatesSend, partner: PartnerChatContext, id: string, tourId: string, dates: string[], seats: number,
  fallbackTitle: string, flags: PastFlags & { priceMentioned: boolean; weekdayWords: boolean; rule: string | null },
  nowMs: number,
): Promise<void> {
  const today = kamchatkaDate(new Date(nowMs));
  const [preview, autoConfirm] = await Promise.all([
    previewDates(chatOpenInput(partner.partnerId, tourId, dates, seats, today)),
    readAutoConfirm(partner.partnerId),
  ]);
  if (preview && !preview.ok) {
    await send(preview.reason === 'tour_inactive' ? FLOW_TEXT.hidden(preview.title) : 'Тур снят с продажи или больше не ваш — даты не открыты.');
    return;
  }
  const view = proposalText({
    tourTitle: preview?.tour.title ?? fallbackTitle,
    seats,
    dates,
    perDate: preview?.perDate ?? null,
    facts: preview ? { maxParticipants: preview.tour.maxParticipants, isPublished: preview.tour.isPublished, days: preview.tour.days } : null,
    autoConfirm,
    ...flags,
  });
  await send(view.text, view.canOpen
    ? [[{ text: 'Открыть', payload: odOpen(id), intent: 'positive' }], cancelRow(id)]
    : undefined);
}

/**
 * Голое число в чате. Места — только черновику, который ждёт мест после
 * выбранного тура; черновику, где тур ещё выбирается, — «тур кнопкой»: номер
 * тура текстом местами не становится. Черновика нет — число помощнику.
 *
 * Повтор того же сообщения MAX (тот же mid) — ничего: ни второго
 * предложения, ни «8» помощнику-модели (второй ревью 22.10: вторая копия
 * уходила помощнику, а сырое «8» — в его историю).
 */
async function answerSeats(
  chatId: number, sourceMid: string | null, partner: PartnerChatContext, seats: number | null, send: DatesSend, nowMs: number,
  sentAtMs: number | null,
): Promise<boolean> {
  if (seats === null) return false;
  if (seats >= 1 && seats <= 500) {
    const filled = await fillDraftSeats(partner.partnerId, chatId, seats, sourceMid, sentAtMs);
    if (filled.kind === 'filled') { await continueDraft(filled.state, partner, send, nowMs); return true; }
    if (filled.kind === 'duplicate_mid') return true;
    if (filled.kind === 'failed') { await send(FLOW_TEXT.draftUnread); return true; }
  }
  const waits = await draftWaiting(partner.partnerId, chatId);
  switch (waits) {
    case 'none': return false;
    case null: await send(FLOW_TEXT.draftUnread); return true;
    case 'tour': await send(FLOW_TEXT.chooseTourFirst); return true;
    // Число в пределах, а черновик всё ещё ждёт мест — запись разминулась с
    // ним (истёк или заменён между запросами): не угадываем, просим повторить.
    case 'seats': await send(seats >= 1 && seats <= 500 ? FLOW_TEXT.draftUnread : FLOW_TEXT.badSeats(seats)); return true;
  }
}

/** После мест или выбора тура: ещё вопрос или предложение. */
async function continueDraft(s: ProposalState, partner: PartnerChatContext, send: DatesSend, nowMs: number): Promise<void> {
  const flags = { priceMentioned: s.priceMentioned, weekdayWords: s.weekdayWords, today: kamchatkaDate(new Date(nowMs)), rule: s.rule };
  const tours = await readPartnerTours(partner.partnerId);
  const title = (tid: string) => tours?.find((t) => t.id === tid)?.title ?? `тур ${tid}`;
  if (s.tourId === null) {
    await sendChoose(send, s.id, s.dates, s.seats, s.candidateIds.map(title), flags);
    return;
  }
  if (s.seats === null) {
    await send(askSeatsText({ tourTitle: title(s.tourId), dates: s.dates, ...flags }), [cancelRow(s.id)]);
    return;
  }
  await sendProposal(send, partner, s.id, s.tourId, s.dates, s.seats, title(s.tourId), flags, nowMs);
}

// ── Нажатие ───────────────────────────────────────────────────────────────

/**
 * Нажатие кнопки `od:` в чате кабинета (апдейт заверен, чат — из сообщения
 * с кнопкой, диалог: это проверил роут). Каждая проверка даёт свой исход:
 * «не смог проверить» не выдаётся за «нельзя», и наоборот (§4.0).
 */
export async function handleOperatorDatesPress(opts: {
  payload: string;
  chatId: number;
  lookup: PartnerChatLookup;
  send: DatesSend;
  nowMs?: number;
}): Promise<void> {
  const { chatId, lookup, send } = opts;
  if (!CHAT_OPEN_DATES_ENABLED) { await send(FLOW_TEXT.switchedOff()); return; }
  if (lookup.outcome === 'unavailable') { await send(FLOW_TEXT.pressUnverifiedPartner()); return; }
  if (lookup.outcome === 'none' || lookup.partner.category !== 'operator') { await send(FLOW_TEXT.pressNotHere); return; }
  const partner = lookup.partner;
  if (!partner.userId) { await send(FLOW_TEXT.noAccount()); return; }
  const press = parseOdPayload(opts.payload);
  if (!press) { await send(FLOW_TEXT.badButton); return; }
  const nowMs = opts.nowMs ?? Date.now();

  if (press.action === 'cancel') {
    const r = await pressCancel(partner.partnerId, chatId, press.id);
    await send(r.kind === 'cancelled_now' ? FLOW_TEXT.cancelled : blockedText(r, FLOW_TEXT.dbFailedPress));
    return;
  }

  if (press.action === 'tour') {
    // Повтор выбора того же тура (двойное касание, повтор callback от MAX) —
    // тоже `chosen`, без записи: предложение показывается снова, а не
    // «кнопка устарела» рядом с рабочим предложением (второй ревью 22.10).
    const r = await pressTour(partner.partnerId, chatId, press.id, press.index);
    if (r.kind === 'chosen') { await continueDraft(r.state, partner, send, nowMs); return; }
    await send(r.kind === 'stale_button' ? FLOW_TEXT.staleButton : blockedText(r, FLOW_TEXT.dbFailedPress));
    return;
  }

  const r = await pressOpen(partner.partnerId, chatId, press.id, kamchatkaDate(new Date(nowMs)));
  switch (r.kind) {
    case 'done':
      await saveMsg(chatId, 'operator_tg', 'assistant', historyResult(r.outcome));
      await send(outcomeText(r.outcome));
      return;
    case 'need_tour': await send(FLOW_TEXT.needTour); return;
    case 'need_seats': await send(FLOW_TEXT.needSeats); return;
    default: await send(blockedText(r, FLOW_TEXT.dbFailed));
  }
}

function blockedText(r: PressBlocked, dbFailed: string): string {
  switch (r.kind) {
    case 'not_found': return FLOW_TEXT.notFound;
    case 'done_before': return repeatText(r.usedAt, r.outcome);
    case 'superseded': return FLOW_TEXT.superseded;
    case 'cancelled': return FLOW_TEXT.wasCancelled;
    case 'expired': return FLOW_TEXT.expired;
    case 'failed': return dbFailed;
  }
}
