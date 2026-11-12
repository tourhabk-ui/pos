/**
 * lib/requests/other-offers-status.ts — «другие компании к месту на дату» в
 * виде заявки: ответ get_request_status ИИ-агенту и страница заявки (план
 * «после отказа», этап 4а, второй срез).
 *
 * Первый срез (lib/requests/answer-notice) называл другие компании только в
 * сообщении человеку в чат. Заявка, которую создал ИИ-агент, чатов не имеет:
 * её ответ доходит прочтением статуса — и там о других компаниях не было ни
 * слова. Человек получал «мест нет» и совет искать другой тур.
 *
 * Правило «когда называть» — то же, что у сообщения (answerWantsOffers):
 * две сборки разошлись бы, и чат назвал бы компании, а статус той же заявки —
 * нет. Отбор и порядок — тот же загрузчик (lib/requests/other-offers).
 *
 * Три исхода и «не про эту заявку» (§4.0):
 *   listed — компании названы;
 *   none   — Ведар проверил и не нашёл;
 *   failed — не прочиталось или не уложилось в срок: это не «не нашёл»;
 *   null   — вид заявки не из отказа туроператора (или отказ по погоде,
 *            большая группа, нет тура и даты, дата прошла).
 *
 * Имя и телефон человека сюда не читаются: в чтение идут тур, дата и число
 * людей. Только сервер. Сторожа: tests/unit/other-offers-status.test.ts
 * (правило и три исхода — вызовом), tests/integration/request-chat.pg.test.ts
 * (сцена «другие компании на дату»).
 */
import { isClientLostReason } from '@/lib/leads/lost-reason';
import { groupPassedOnAnswer, shownAnswerRef, type RequestCore, type StatusRow } from '@/lib/mcp/request-status';
import { answerWantsOffers } from '@/lib/requests/answer-notice-text';
import { DECLINE_REASONS, type DeclineReason } from '@/lib/requests/chat-answer-buttons';
import { loadOtherOffers } from '@/lib/requests/other-offers';
import type { OtherOfferSeats } from '@/lib/requests/other-offers-words';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { OFFER_ORDER_NOTE_ON_DATE_RU } from '@/lib/tours/offer-order';

/** Срок чтения: статус читают живьём (агент ждёт ответа инструмента, человек — страницу). */
export const STATUS_OFFERS_TIMEOUT_MS = 5_000;

/** Строка списка — компания и её тур, который может принять на дату. */
export interface RequestOtherOffer {
  company: string;
  tour: string;
  /** Номер тура в каталоге — им оставляют заявку: create_booking_request. */
  tour_id: string;
  /** Цена словами с единицей; null — не записана. */
  price: string | null;
  seats: OtherOfferSeats;
  /** Форма заявки тура с подставленными датой и числом людей. */
  url: string;
  /** Сколько ещё туров этой компании к месту могут принять на дату. */
  more_tours: number;
}

export interface RequestOtherOffers {
  state: 'listed' | 'none' | 'failed';
  /** Место, к которому идут туры, и его страница; не `listed` — null. */
  place: string | null;
  place_url: string | null;
  /** На какую дату считали. */
  date: string;
  /** На сколько человек считали места; null — в заявке не записано, считали на одного. */
  participants: number | null;
  offers: RequestOtherOffer[];
  /** Сколько компаний в список не вошло — они на странице места. */
  more_companies: number;
  /** Что это за список и что с ним делать — словами для агента. */
  how: string;
}

/** То же без слов для агента: страница заявки говорит с человеком своими словами. */
export type PageOtherOffers = Omit<RequestOtherOffers, 'how'>;

const HOW_LISTED =
  'Это туры других компаний к тому же месту на ту же дату — не ответ этих компаний: места и дату каждая подтверждает сама. '
  + 'seats: calendar — в календаре тура на эту дату мест на всю группу хватает; by_request — расписания на Ведаре нет, дату подтверждает оператор. '
  + 'Назовите их человеку как есть, без «лучше» и «дешевле»: компанию выбирает человек, не вы. '
  + 'Заявку выбранной компании оставляет человек по url или вы — create_booking_request с её tour_id, только после его согласия: '
  + 'имя и телефон получит только эта компания. '
  + OFFER_ORDER_NOTE_ON_DATE_RU;

const HOW_NONE =
  'Ведар не нашёл других компаний с турами к главному месту этого тура, которые по его данным могут принять на эту дату. '
  + 'Связь с местом записана не у каждого тура: искать шире — get_tours, другие даты этого тура — get_tour_availability.';

const HOW_FAILED =
  'Список других компаний сейчас не прочитался — это не значит, что их нет. '
  + 'Спросите статус ещё раз позже или найдите туры к месту сами: get_place_info, get_tours.';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isDeclineReason(v: string | null | undefined): v is DeclineReason {
  return typeof v === 'string' && (DECLINE_REASONS as readonly string[]).includes(v);
}

/** О чём спрашивать загрузчик: отказанный тур, дата заявки, число людей. */
export interface OtherOffersAsk {
  tourId: string;
  date: string;
  /** Число людей из заявки; null — не записано (места считаются на одного). */
  people: number | null;
}

/**
 * Называть ли другие компании в виде заявки — и по каким фактам. Вид должен
 * быть построен из отказа туроператора: кнопка «Нет мест» / «Отказать» или
 * закрытие заявки с причиной продавца (shownAnswerRef). Заявка `lost` без
 * записанного ответа сюда не входит: причина неизвестна, а после отказа по
 * погоде то же место в тот же день называть нельзя.
 */
export function otherOffersAsk(
  row: StatusRow, core: Pick<RequestCore, 'kind' | 'state'>, today: string,
): OtherOffersAsk | null {
  if (core.kind !== 'lead' || core.state !== 'declined') return null;
  const ref = shownAnswerRef(row);
  if (!ref || ref.source === 'vehicle') return null;
  const closed = ref.source === 'closed';
  // Причина на стороне клиента («не отвечает», «передумал») — не отказ продавца.
  if (closed && isClientLostReason(row.lead_lost_reason)) return null;
  const answer = closed ? 'decline' : row.lead_answer;
  if (answer !== 'no_seats' && answer !== 'decline') return null;
  const rawReason = (closed ? row.lead_lost_reason : row.lead_decline_reason) ?? null;
  const groupPassedOn = row.lead_group_over === true && groupPassedOnAnswer(answer, rawReason);
  if (!answerWantsOffers({ kind: 'tour', answer, reason: isDeclineReason(rawReason) ? rawReason : null, groupPassedOn })) return null;
  const tourId = row.lead_tour_id ?? null;
  const date = row.lead_requested_date ?? null;
  if (!tourId || !date || !ISO_DAY.test(date) || date < today) return null;
  const people = Number(row.lead_people ?? 0);
  return { tourId, date, people: Number.isFinite(people) && people > 0 ? Math.trunc(people) : null };
}

export interface StatusOffersDeps {
  load?: typeof loadOtherOffers;
  now?: () => number;
  timeoutMs?: number;
}

/** Срок не отменяет начатое чтение — оно доработает само; исход назван `failed`. */
async function inTime<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; why: 'timeout' | 'exception' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ ok: false; why: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, why: 'timeout' }), ms); });
  const done = p.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const, why: 'exception' as const }),
  );
  try {
    return await Promise.race([done, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Другие компании для вида заявки. Никогда не бросает: статус заявки важнее
 * списка — не прочиталось, и вид уходит с `failed`, а не падает целиком.
 */
export async function readStatusOtherOffers(
  row: StatusRow, core: Pick<RequestCore, 'kind' | 'state'>, deps: StatusOffersDeps = {},
): Promise<RequestOtherOffers | null> {
  const now = (deps.now ?? Date.now)();
  const ask = otherOffersAsk(row, core, kamchatkaToday(now));
  if (!ask) return null;
  const base = { place: null, place_url: null, date: ask.date, participants: ask.people, offers: [], more_companies: 0 };
  const run = await inTime(
    (deps.load ?? loadOtherOffers)({ tourId: ask.tourId, date: ask.date, people: ask.people ?? 1 }, { now: new Date(now) }),
    deps.timeoutMs ?? STATUS_OFFERS_TIMEOUT_MS,
  );
  if (!run.ok) {
    console.warn(`[other-offers-status] другие компании на дату не прочитались (${run.why}) — вид заявки уходит без них`);
    return { ...base, state: 'failed', how: HOW_FAILED };
  }
  const o = run.value;
  if (o.state === 'failed') return { ...base, state: 'failed', how: HOW_FAILED };
  if (o.state === 'none') return { ...base, state: 'none', how: HOW_NONE };
  return {
    state: 'listed',
    place: o.placeName,
    place_url: o.placeUrl,
    date: ask.date,
    participants: ask.people,
    offers: o.offers.map((x) => ({
      company: x.partnerName, tour: x.title, tour_id: x.tourId, price: x.price, seats: x.seats, url: x.url, more_tours: x.moreTours,
    })),
    more_companies: o.more,
    how: HOW_LISTED,
  };
}

/** Для страницы заявки: без слов для агента. */
export function pageOtherOffers(o: RequestOtherOffers | null | undefined): PageOtherOffers | null {
  if (!o) return null;
  const { how: _how, ...rest } = o;
  return rest;
}
