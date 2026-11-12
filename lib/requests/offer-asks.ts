/**
 * lib/requests/offer-asks.ts — вопрос другим компаниям после отказа: «возьмёте
 * на эту дату?» (план «после отказа», этап 4б; слова владельца 11.11:
 * «передавать другим — да», «карт-бланш по плану действуй»).
 *
 * Этап 4а называл человеку другие компании к тому же месту по КАЛЕНДАРЮ. Это
 * не слово компании, а у тура без расписания «может принять» неизвестно
 * вовсе. Здесь Ведар спрашивает сами компании.
 *
 * Правила:
 *  - вопрос — не заявка: в нём место, дата, число людей и тур самой компании.
 *    Имя и телефон человека в вопрос не читаются и компаниям не уходят:
 *    согласие он давал одному оператору. Компании, ответившей «Беру», заявку
 *    он оставляет сам — по ссылке на форму её тура;
 *  - спрашиваются те же компании, что названы человеку (lib/requests/other-offers,
 *    тот же отбор и тот же предел), все сразу, одним текстом: очереди и выбора
 *    Ведара нет, и это сказано в самом вопросе;
 *  - когда спрашивать — то же правило, что «называть ли других» в виде заявки
 *    (otherOffersAsk): отказ туроператора не по погоде, не большая группа, дата
 *    впереди. Своя проба и заявка без адресата вопросов не рождают;
 *  - вопрос одной компании по заявке и дате — один (UNIQUE), ответ на него —
 *    один: второе нажатие читает записанное;
 *  - кнопки уходят только туда, где нажатие узнает компанию: в MAX карточки и
 *    в Telegram, привязанный к карточке. В личный Telegram аккаунта вопрос не
 *    идёт — кнопка там ответила бы «не выполняю»;
 *  - «Беру» — человеку сообщение в его чат тем же путём, что сообщение об
 *    отказе. Чата нет или он не принял — письмо менеджеру Ведара с именем и
 *    телефоном (только в MAX, sendPdAlert): правило плана «доставлено» — не
 *    дошло до человека, значит сразу менеджеру. Это единственное место, где
 *    модуль читает контакт человека, и компании он не уходит. Сообщается,
 *    только пока заявка всё ещё стоит с тем отказом и той датой и тур компании
 *    всё ещё можно назвать (тот же отбор). «Не могу» человеку не сообщается:
 *    компания просто уходит из его списка.
 *
 * Отправка вопроса — одна попытка: не дошёл — в строке записано почему, а
 * компания остаётся в списке человека по календарю. Повторов по таймеру нет
 * (правило плана: сроков наугад не заводим). Письмо менеджеру о «Беру» — тоже
 * одна попытка: не принято — компании сказано «увидит на странице заявки», а
 * не «передан менеджеру».
 *
 * Только сервер. Сторожа: tests/unit/offer-asks.test.ts (правила, слова,
 * исходы — вызовом), tests/integration/request-chat.pg.test.ts (сцена «вопрос
 * другим компаниям»).
 */
import { pool } from '@/lib/db-pool';
import { REQUEST_STATUS_BY_LEAD_SQL, buildRequestView, type StatusRow } from '@/lib/mcp/request-status';
import type { PdAlertParams, PdAlertResult } from '@/lib/notifications/pd-alert';
import type { PartnerReach } from '@/lib/partners/reach';
import { getPublicBaseUrl } from '@/lib/config';
import { managerQueueUrl } from '@/lib/manager-queue/link';
import { NOTICE_CONTACT_SQL, NOTICE_TARGETS_SQL, defaultSendMax, defaultSendTelegram } from '@/lib/requests/answer-notice';
import {
  managerTookText, offerAskButtons, offerAsksOperatorLine, offerAskText, offerTookText, type OfferAskAnswer, type OfferAskOutcome,
} from '@/lib/requests/offer-asks-text';
import { withinPress } from '@/lib/requests/press-budget';
import { loadOtherOffers } from '@/lib/requests/other-offers';
import { otherOffersAsk } from '@/lib/requests/other-offers-status';
import { kamchatkaToday } from '@/lib/seat-requests/core';

const LOG = '[offer-asks]';

/** Срок одной отправки: вопроса компании и сообщения человеку. */
export const OFFER_ASK_SEND_TIMEOUT_MS = 15_000;
/** Сколько нажатие отказавшего оператора ждёт рассылку вопросов; дальше она идёт сама. */
export const OFFER_ASKS_PRESS_BUDGET_MS = 8_000;

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
type SendResult = { ok: true } | { ok: false; code: string };

export interface OfferAsksDeps {
  query?: Query;
  offers?: typeof loadOtherOffers;
  reach?: (partnerId: string) => Promise<PartnerReach | null>;
  pdAlert?: (p: PdAlertParams) => Promise<PdAlertResult>;
  sendMax?: (chatId: string, text: string, buttons: Array<{ text: string; payload: string }>) => Promise<SendResult>;
  sendTelegram?: (chatId: string, text: string, buttons: Array<{ text: string; payload: string }>) => Promise<SendResult>;
  now?: () => number;
  timeoutMs?: number;
  /** Сколько нажатие «Беру» ждёт сообщение человеку; по умолчанию — общий срок нажатия. */
  pressMs?: number;
}

/**
 * Вопросы компаниям по заявке — одной командой, по строке на компанию.
 * Повторный вызов (второе нажатие, добивка) новых строк не заводит: вернутся
 * лишь только что созданные, и вопрос уйдёт один раз.
 */
export const OFFER_ASKS_INSERT_SQL = `
  INSERT INTO other_offer_asks (lead_id, partner_id, tour_id, ask_date, people)
  SELECT $1::uuid, x.partner_id, x.tour_id, $2::date, $3::int
    FROM unnest($4::uuid[], $5::bigint[]) AS x(partner_id, tour_id)
  ON CONFLICT (lead_id, partner_id, ask_date) DO NOTHING
  RETURNING id::text AS id, partner_id::text AS partner_id, tour_id::text AS tour_id`;

/** Куда вопрос дошёл — или почему не дошёл. */
export const OFFER_ASK_SENT_SQL = `
  UPDATE other_offer_asks SET sent_via = $2::text, send_note = $3::text WHERE id = $1::bigint`;

/**
 * Ответ на вопрос: один, только своей компании и только пока дата впереди.
 * Право — в самом условии записи: чужой номер вопроса не запишется.
 */
export const OFFER_ASK_ANSWER_SQL = `
  UPDATE other_offer_asks
     SET answer = $3::text, answered_at = NOW(), answered_via = $4::text
   WHERE id = $1::bigint AND partner_id = $2::uuid AND answer IS NULL AND ask_date >= $5::date
  RETURNING lead_id::text AS lead_id, tour_id::text AS tour_id, ask_date::text AS ask_date, people`;

/** Почему ответ не записался: вопроса у компании нет, ответ уже есть или дата прошла. */
export const OFFER_ASK_READ_SQL = `
  SELECT answer, (ask_date < $3::date) AS passed
    FROM other_offer_asks
   WHERE id = $1::bigint AND partner_id = $2::uuid`;

export const OFFER_ASK_TOLD_SQL = `
  UPDATE other_offer_asks SET told_via = $2::text, told_at = NOW()
   WHERE id = $1::bigint AND answer = 'take' AND told_via IS NULL`;

/** Куда ушло письмо менеджеру о «Беру» — один раз на вопрос. */
export const OFFER_ASK_MANAGER_SQL = `
  UPDATE other_offer_asks SET manager_via = $2::text, manager_at = NOW()
   WHERE id = $1::bigint AND answer = 'take' AND manager_via IS NULL`;

/** Код отправки — из белого списка: свободный текст ошибки канала мог бы нести id чата. */
const CHAT_CODES = new Set(['no_token', 'bad_id', 'api_error', 'timeout', 'exception']);
const chatCode = (v: string): string => (CHAT_CODES.has(v) ? v : 'api_error');

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'нет SQLSTATE';
}

/** Срок не отменяет начатое: оно доработает само, исход назван по сроку. */
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

async function defaultReach(partnerId: string): Promise<PartnerReach | null> {
  const { reachForPartner } = await import('@/lib/partners/reach');
  return reachForPartner(partnerId);
}

async function defaultPdAlert(p: PdAlertParams): Promise<PdAlertResult> {
  const { sendPdAlert } = await import('@/lib/notifications/pd-alert');
  return sendPdAlert(p);
}

/**
 * Заявка всё ещё стоит с отказом, после которого называют других, — и на
 * какие тур, дату и число людей. Своя проба и заявка без адресата — нет.
 */
async function standingRefusal(q: Query, leadId: string, now: number) {
  const { rows: [st] } = await q(REQUEST_STATUS_BY_LEAD_SQL, [leadId]);
  const row = st as StatusRow | undefined;
  if (!row || row.lead_addressed !== true) return null;
  return otherOffersAsk(row, buildRequestView(row, now), kamchatkaToday(now));
}

export type AskRun =
  /** Заявка не стоит с отказом, после которого называют других: вопросов нет. */
  | { state: 'skip' }
  /** Других компаний к месту на дату нет — спрашивать некого. */
  | { state: 'none' }
  | { state: 'failed' }
  /** Заведено новых вопросов и сколько из них дошло до компаний. */
  | { state: 'asked'; created: number; sent: number };

type SentVia = { via: 'max' | 'telegram' } | { via: null; note: string };

async function sendAsk(
  partnerId: string, askId: string, text: string, deps: OfferAsksDeps, now: number,
): Promise<SentVia> {
  const reach = await (deps.reach ?? defaultReach)(partnerId);
  if (reach === null) return { via: null, note: 'reach_unknown' };
  // Кнопка в личном Telegram аккаунта компанию не узнает (кабинет ищет её по чату карточки).
  const telegram = reach.telegramSource === 'partner' ? reach.telegramChatId : null;
  if (!reach.maxChatId && !telegram) return { via: null, note: 'no_channel' };
  const buttons = offerAskButtons(askId, now);
  const res = await inTime((deps.pdAlert ?? defaultPdAlert)({
    // ПД в вопросе нет по построению — текст один на оба канала.
    text, stub: text, buttons, stubActions: telegram ? buttons : [],
    to: { maxChatId: reach.maxChatId, telegramChatId: telegram },
  }), deps.timeoutMs ?? OFFER_ASK_SEND_TIMEOUT_MS);
  if (!res.ok) return { via: null, note: res.why };
  if (res.value.channel === 'max' && res.value.delivered) return { via: 'max' };
  if (res.value.channel === 'telegram-stub') return { via: 'telegram' };
  return { via: null, note: 'not_delivered' };
}

/**
 * Спросить другие компании по заявке, которой отказали. Никогда не бросает:
 * вопросы — довесок к сообщению человеку, и их сбой ничего не отменяет.
 */
export async function askOtherCompanies(leadId: string, deps: OfferAsksDeps = {}): Promise<AskRun> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  const now = (deps.now ?? Date.now)();
  try {
    const ask = await standingRefusal(q, leadId, now);
    if (!ask) return { state: 'skip' };
    const people = ask.people ?? 1;
    const offers = await (deps.offers ?? loadOtherOffers)(
      { tourId: ask.tourId, date: ask.date, people, leadId }, { now: new Date(now) },
    );
    if (offers.state === 'failed') return { state: 'failed' };
    if (offers.state === 'none') return { state: 'none' };

    const created = (await q(OFFER_ASKS_INSERT_SQL, [
      leadId, ask.date, people, offers.offers.map((o) => o.partnerId), offers.offers.map((o) => o.tourId),
    ])).rows as Array<{ id: string; partner_id: string; tour_id: string }>;

    const results = await Promise.all(created.map(async (c): Promise<boolean> => {
      const offer = offers.offers.find((o) => o.partnerId === c.partner_id && o.tourId === c.tour_id);
      let sent: SentVia = { via: null, note: 'no_offer' };
      if (offer) {
        const text = offerAskText({ placeName: offers.placeName, date: ask.date, people, tourTitle: offer.title });
        try {
          sent = await sendAsk(c.partner_id, c.id, text, deps, now);
        } catch (err) {
          console.error(`${LOG} вопрос ${c.id} не отправлен, SQLSTATE`, codeOf(err));
          sent = { via: null, note: 'exception' };
        }
      }
      try {
        await q(OFFER_ASK_SENT_SQL, [c.id, sent.via, sent.via ? null : sent.note]);
      } catch (err) {
        console.error(`${LOG} исход вопроса ${c.id} не записан, SQLSTATE`, codeOf(err));
      }
      if (!sent.via) console.warn(`${LOG} вопрос ${c.id} до компании не дошёл (${sent.note})`);
      return sent.via !== null;
    }));
    return { state: 'asked', created: created.length, sent: results.filter(Boolean).length };
  } catch (err) {
    console.error(`${LOG} вопросы по заявке ${leadId} не заведены, SQLSTATE`, codeOf(err));
    return { state: 'failed' };
  }
}

/**
 * То же в пределах нажатия отказавшего оператора: строка ему — только о
 * вопросах, которые дошли. Срок вышел — рассылка идёт сама, строки нет:
 * сказать «задан вопрос» о недошедшем было бы неправдой.
 */
export async function askOtherCompaniesWithinPress(leadId: string, deps: OfferAsksDeps = {}): Promise<string | null> {
  const run = await withinPress<AskRun | null>(askOtherCompanies(leadId, deps), null, OFFER_ASKS_PRESS_BUDGET_MS);
  return run && run.state === 'asked' ? offerAsksOperatorLine(run.sent) : null;
}

type Told = Extract<OfferAskOutcome, { state: 'took' }>;

/**
 * Чат человека «Беру» не принял или чата нет — письмо менеджеру, чтобы
 * позвонил. Имя и телефон читаются только здесь и уходят только в MAX
 * менеджера; в Telegram — заглушка без них. null — письмо никто не принял.
 */
async function tellManager(
  q: Query, leadId: string, askId: string, facts: Parameters<typeof offerTookText>[0], tried: string[], deps: OfferAsksDeps,
): Promise<'max' | 'telegram-stub' | null> {
  let channel: 'max' | 'telegram-stub' | null = null;
  try {
    const { rows: [c] } = await q(NOTICE_CONTACT_SQL, [leadId]);
    const contact = (c ?? {}) as { name?: string | null; phone?: string | null };
    const msg = managerTookText({ ...facts, leadId, tried }, { name: contact.name ?? null, phone: contact.phone ?? null });
    const res = await inTime((deps.pdAlert ?? defaultPdAlert)({
      text: msg.text, stub: msg.stub,
      buttons: [
        { text: 'Очередь менеджера', url: managerQueueUrl() },
        { text: 'Заявки в админке', url: `${getPublicBaseUrl()}/hub/admin/leads` },
      ],
    }), deps.timeoutMs ?? OFFER_ASK_SEND_TIMEOUT_MS);
    if (res.ok) channel = res.value.channel === 'max' && res.value.delivered ? 'max' : res.value.channel === 'telegram-stub' ? 'telegram-stub' : null;
    if (!channel) {
      console.error(`${LOG} вопрос ${askId}: письмо менеджеру о «Беру» не дошло (${res.ok ? res.value.channel : res.why})`);
      return null;
    }
  } catch (err) {
    console.error(`${LOG} вопрос ${askId}: письмо менеджеру о «Беру» не собрано, SQLSTATE`, codeOf(err));
    return null;
  }
  try {
    await q(OFFER_ASK_MANAGER_SQL, [askId, channel]);
  } catch (err) {
    // Письмо менеджер получил — исход «передано» правдив и без отметки.
    console.error(`${LOG} вопрос ${askId}: канал письма менеджеру не записан, SQLSTATE`, codeOf(err));
  }
  return channel;
}

/** «Беру» записано — сказать человеку. Сбой ответа компании не отменяет. */
async function tellPerson(
  q: Query, saved: { lead_id: string; ask_date: string }, askId: string, partnerId: string, deps: OfferAsksDeps, now: number,
): Promise<Told> {
  try {
    const ask = await standingRefusal(q, saved.lead_id, now);
    // Заявка переросла отказ или человек сменил дату — «возьмёт на прежнюю дату» ему уже не нужно.
    if (!ask || ask.date !== saved.ask_date) return { state: 'took', told: 'outgrown' };
    const offers = await (deps.offers ?? loadOtherOffers)(
      { tourId: ask.tourId, date: ask.date, people: ask.people ?? 1, leadId: saved.lead_id }, { now: new Date(now) },
    );
    if (offers.state === 'failed') return { state: 'took', told: 'unknown' };
    // Тем же отбором, что список человека: тур снят с витрины или дата закрыта — не называем.
    const mine = offers.state === 'ok' ? offers.offers.find((o) => o.partnerId === partnerId && o.said === 'take') : undefined;
    if (!mine) return { state: 'took', told: 'unlisted' };
    const facts = {
      partnerName: mine.partnerName, tourTitle: mine.title, price: mine.price, date: ask.date, people: ask.people, url: mine.url,
    };
    const text = offerTookText(facts);
    const tried: string[] = [];
    const targets = (await q(NOTICE_TARGETS_SQL, [saved.lead_id])).rows as Array<{ channel: 'max' | 'telegram'; chat_id: string }>;
    for (const t of targets) {
      const send = t.channel === 'max' ? (deps.sendMax ?? defaultSendMax) : (deps.sendTelegram ?? defaultSendTelegram);
      const res = await inTime(send(String(t.chat_id), text, []), deps.timeoutMs ?? OFFER_ASK_SEND_TIMEOUT_MS);
      if (res.ok && res.value.ok) {
        await q(OFFER_ASK_TOLD_SQL, [askId, t.channel]);
        return { state: 'took', told: t.channel, date: ask.date, tourTitle: mine.title };
      }
      tried.push(`${t.channel}:${chatCode(res.ok ? (res.value.ok ? 'api_error' : res.value.code) : res.why)}`);
      console.warn(`${LOG} вопрос ${askId}: ${t.channel} человека сообщение не принял`);
    }
    // Не дошло до человека — сразу менеджеру: слово компании «возьму» не должно лежать непрочитанным.
    const manager = await tellManager(q, saved.lead_id, askId, facts, tried, deps);
    return { state: 'took', told: manager ? 'manager' : 'status', date: ask.date, tourTitle: mine.title };
  } catch (err) {
    console.error(`${LOG} вопрос ${askId}: человеку о «Беру» не сообщено, SQLSTATE`, codeOf(err));
    return { state: 'took', told: 'unknown' };
  }
}

/**
 * Нажатие компании на вопрос. Кто нажал — из привязки чата (вызывающий), не
 * из кнопки; номер вопроса из кнопки проверяется условием записи.
 */
export async function answerOfferAsk(
  args: { partnerId: string; askId: string; answer: OfferAskAnswer; via: 'max' | 'telegram' },
  deps: OfferAsksDeps = {},
): Promise<OfferAskOutcome> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  const now = (deps.now ?? Date.now)();
  const today = kamchatkaToday(now);
  let saved: { lead_id: string; tour_id: string; ask_date: string; people: number } | undefined;
  try {
    saved = (await q(OFFER_ASK_ANSWER_SQL, [args.askId, args.partnerId, args.answer, args.via, today])).rows[0] as typeof saved;
    if (!saved) {
      const was = (await q(OFFER_ASK_READ_SQL, [args.askId, args.partnerId, today])).rows[0] as { answer: string | null; passed: boolean } | undefined;
      if (!was) return { state: 'not_yours' };
      if (was.answer === 'take' || was.answer === 'decline') return { state: 'already', answer: was.answer };
      return was.passed === true ? { state: 'date_passed' } : { state: 'failed' };
    }
  } catch (err) {
    console.error(`${LOG} ответ на вопрос ${args.askId} не записан, SQLSTATE`, codeOf(err));
    return { state: 'failed' };
  }
  if (args.answer === 'decline') return { state: 'declined' };
  // Ответ уже записан. Сообщение человеку ждём не дольше срока нажатия: зависший
  // канал не держит вебхук, отправка доработает сама, компании сказано «отправляется».
  return withinPress<OfferAskOutcome>(
    tellPerson(q, saved, args.askId, args.partnerId, deps, now), { state: 'took', told: 'sending' }, deps.pressMs,
  );
}
