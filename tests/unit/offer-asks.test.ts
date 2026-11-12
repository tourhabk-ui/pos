// @vitest-environment node
/**
 * Вопрос другим компаниям после отказа: «возьмёте на эту дату?» (план «после
 * отказа», этап 4б).
 *
 * Держит: вопрос уходит тем же компаниям, что названы человеку, и только
 * когда заявка стоит с отказом, после которого других называют (не погода, не
 * большая группа, не своя проба); в вопросе нет имени и телефона человека;
 * кнопки уходят лишь туда, где нажатие узнает компанию; вопрос и ответ — по
 * одному; ответить может только та компания, которой вопрос задан; «Беру» —
 * человеку сообщение, пока заявка всё ещё с тем отказом и той датой, «Не
 * могу» — ничего; каждый исход назван компании своими словами.
 *
 * Всё — вызовом: правило на строке заявки, отправка и база — подменены.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
process.env.CALLBACK_SIGNING_SECRET = 'unit-test-signing';

import {
  askOtherCompanies, askOtherCompaniesWithinPress, answerOfferAsk,
  OFFER_ASKS_INSERT_SQL, OFFER_ASK_ANSWER_SQL, OFFER_ASK_MANAGER_SQL, OFFER_ASK_READ_SQL, OFFER_ASK_SENT_SQL, OFFER_ASK_TOLD_SQL,
  OFFER_ASK_SEND_TIMEOUT_MS, OFFER_ASKS_PRESS_BUDGET_MS, type OfferAsksDeps,
} from '@/lib/requests/offer-asks';
import {
  isOfferAskPayload, managerTookText, offerAskButtons, offerAskPayload, offerAskReplyText, offerAsksOperatorLine, offerAskText, offerTookText,
  parseOfferAskPress, type OfferAskOutcome,
} from '@/lib/requests/offer-asks-text';
import { NOTICE_CONTACT_SQL, NOTICE_TARGETS_SQL } from '@/lib/requests/answer-notice';
import { REQUEST_STATUS_BY_LEAD_SQL, type StatusRow } from '@/lib/mcp/request-status';
import { CALLBACK_MAX_BYTES, isWritePayload, unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { NOTICE_PRESS_BUDGET_MS } from '@/lib/requests/press-budget';
import type { PartnerReach } from '@/lib/partners/reach';

/** Сегодня по Камчатке — 10.01.2027: заявка на 15.01 впереди. */
const NOW = Date.parse('2027-01-10T00:00:00Z');
const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const [A, B, C, D] = ['a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-00000000000c', 'd0000000-0000-4000-8000-00000000000d'];

const ROW: StatusRow = {
  key_id: 'K', tool_name: 'create_booking_request', lead_id: LEAD, seat_request_id: null,
  lead_status: 'new', route_title: 'Вулкан Горелый', lead_requested_date: '2027-01-15', lead_tour: 'Вулкан Горелый',
  lead_tour_id: '70', lead_people: 3, lead_participants: 3,
  booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
  seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null, seat_tour: null,
  lead_consent_at: null, lead_consent_source: null, seat_consent_at: null, seat_consent_source: null,
  stay_request_id: null, stay_accommodation_id: null, stay_name: null, stay_check_in: null, stay_check_out: null, stay_guests: null,
  stay_owner_channel: null, stay_platform_channel: null, stay_delivery_recorded_at: null, stay_consent_at: null, stay_consent_source: null,
  opens_chat: true, lead_addressed: true,
  lead_answer: 'no_seats', lead_answer_id: '77',
};

const offer = (partnerId: string, name: string, tourId: string, title: string, said: 'take' | null = null) => ({
  partnerId, partnerName: name, tourId, title, price: '12 000 ₽ за человека', seats: 'calendar' as const,
  url: `https://vedarai.ru/catalog/tours/${tourId}?date=2027-01-15&guests=3#booking`, moreTours: 0, said,
});
const OFFERS = {
  state: 'ok' as const, placeName: 'Вулкан <Горелый>', placeUrl: 'https://vedarai.ru/places/gorely#tours', more: 0,
  offers: [offer(B, 'Компания «Б»', '201', 'Горелый & кратер'), offer(C, 'Третья', '202', 'К кратеру'), offer(D, 'Четвёртая', '203', 'Пешком')],
};

const reachOf = (over: Partial<PartnerReach>): PartnerReach => ({
  category: 'operator', sellsTours: true, telegramChatId: null, maxChatId: null, telegramSource: null, reachable: false, ...over,
});

/** Мир одного теста: строка заявки, что вернёт INSERT, адреса компаний, исходы отправок. */
function world(over: {
  row?: StatusRow | null;
  created?: Array<{ id: string; partner_id: string; tour_id: string }>;
  reach?: Record<string, PartnerReach | null>;
  targets?: Array<{ channel: 'max' | 'telegram'; chat_id: string }>;
  answered?: { lead_id: string; tour_id: string; ask_date: string; people: number } | null;
  was?: { answer: string | null; passed: boolean } | null;
} = {}) {
  const ran: Array<{ sql: string; params: unknown[] }> = [];
  const q = vi.fn(async (sql: string, params: unknown[] = []) => {
    ran.push({ sql, params });
    if (sql === REQUEST_STATUS_BY_LEAD_SQL) return { rows: over.row === null ? [] : [over.row ?? ROW] };
    if (sql === OFFER_ASKS_INSERT_SQL) return { rows: over.created ?? [{ id: '11', partner_id: B, tour_id: '201' }, { id: '12', partner_id: C, tour_id: '202' }, { id: '13', partner_id: D, tour_id: '203' }] };
    if (sql === OFFER_ASK_ANSWER_SQL) return { rows: over.answered === null ? [] : [over.answered ?? { lead_id: LEAD, tour_id: '201', ask_date: '2027-01-15', people: 3 }] };
    if (sql === OFFER_ASK_READ_SQL) return { rows: over.was ? [over.was] : [] };
    if (sql === NOTICE_TARGETS_SQL) return { rows: over.targets ?? [{ channel: 'max', chat_id: '555' }] };
    if (sql === NOTICE_CONTACT_SQL) return { rows: [{ name: 'Анна <Петрова>', phone: '+7 900 123-45-67' }] };
    return { rows: [], rowCount: 1 };
  });
  const offers = vi.fn(async () => OFFERS as unknown);
  const reaches: Record<string, PartnerReach | null> = over.reach ?? {
    [B]: reachOf({ maxChatId: '802', reachable: true }),
    [C]: reachOf({ telegramChatId: '903', telegramSource: 'partner', reachable: true }),
    [D]: reachOf({ maxChatId: '804', telegramChatId: '904', telegramSource: 'partner', reachable: true }),
  };
  const reach = vi.fn(async (id: string) => (id in reaches ? reaches[id]! : reachOf({})));
  // Без адресата письмо идёт менеджеру — в его рабочий MAX; с адресатом — компании: в её MAX или заглушкой в Telegram.
  const pdAlert = vi.fn(async (p: { to?: { maxChatId?: unknown } }) => (
    !p.to || p.to.maxChatId ? { channel: 'max' as const, delivered: true, reason: 'ok' } : { channel: 'telegram-stub' as const, delivered: false, reason: 'ok' }
  ));
  const sendMax = vi.fn(async () => ({ ok: true as const }));
  const sendTelegram = vi.fn(async () => ({ ok: true as const }));
  const deps = { query: q, offers, reach, pdAlert, sendMax, sendTelegram, now: () => NOW } as unknown as OfferAsksDeps;
  const of = (sql: string) => ran.filter((r) => r.sql === sql);
  return { deps, q, offers, reach, pdAlert, sendMax, sendTelegram, ran, of };
}

beforeEach(() => { query.mockReset(); });

describe('кнопки вопроса', () => {
  it('«Беру» и «Не могу» — кнопки-записи: подписаны, влезают в предел, разбираются обратно', () => {
    const buttons = offerAskButtons('123456789012345678', NOW);
    expect(buttons.map((b) => b.text)).toEqual(['Беру', 'Не могу']);
    for (const [i, b] of buttons.entries()) {
      expect(Buffer.byteLength(b.payload)).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
      const press = unwrapPress(b.payload, NOW);
      expect(press).toEqual({ ok: true, payload: offerAskPayload('123456789012345678', i === 0 ? 'take' : 'decline') });
      // Подделанный хвост и неподписанная кнопка — отказ: ответ за компанию никто не подставит.
      expect(unwrapPress(`${b.payload.slice(0, -1)}${b.payload.endsWith('A') ? 'B' : 'A'}`, NOW)).toEqual({ ok: false, reason: 'forged' });
    }
    expect(isWritePayload('oq:y:7')).toBe(true);
    expect(isWritePayload('oq:n:7')).toBe(true);
    // Без подписи кнопка-запись не принимается (льготное окно старых кнопок давно закрыто).
    const legacy = process.env.CALLBACK_LEGACY_UNTIL_MS;
    process.env.CALLBACK_LEGACY_UNTIL_MS = '1';
    try {
      expect(unwrapPress('oq:y:7', NOW)).toEqual({ ok: false, reason: 'expired' });
    } finally {
      if (legacy === undefined) delete process.env.CALLBACK_LEGACY_UNTIL_MS;
      else process.env.CALLBACK_LEGACY_UNTIL_MS = legacy;
    }
    expect(parseOfferAskPress('oq:y:7')).toEqual({ askId: '7', answer: 'take' });
    expect(parseOfferAskPress('oq:n:7')).toEqual({ askId: '7', answer: 'decline' });
    for (const bad of ['oq:x:7', 'oq:y:', 'oq:y:abc', 'oq:y:7:8', 'oq:y:1234567890123456789', 'ia:y:7']) expect(parseOfferAskPress(bad)).toBeNull();
    expect(isOfferAskPayload('oq:что угодно')).toBe(true);
    expect(isOfferAskPayload('ia:a:l:1')).toBe(false);
  });
});

describe('слова', () => {
  it('вопрос: не заявка, без ПД, что будет после каждого ответа, и что спрошены все — по общему правилу', () => {
    const text = offerAskText({ placeName: 'Вулкан <Горелый>', date: '2027-01-15', people: 3, tourTitle: 'Горелый & кратер' });
    expect(text).toContain('<b>Вопрос от Ведара — это не заявка</b>');
    expect(text).toContain('тур к месту «Вулкан &lt;Горелый&gt;» на 15.01.2027, 3 чел.');
    expect(text).toContain('У вас к этому месту есть тур «Горелый &amp; кратер». Возьмёте на эту дату?');
    expect(text).toContain('Имени и телефона в вопросе нет.');
    expect(text).toContain('сам оставит вам заявку');
    expect(text).toContain('Ответите «Не могу» — в его списке вашей компании не будет.');
    expect(text).toContain('Такой же вопрос получили другие компании с турами к этому месту — всем сразу, по общему правилу.');
  });

  it('человеку о «Беру»: чьё это слово, что это не бронь, ссылка на форму и кому уйдёт телефон', () => {
    const text = offerTookText({
      partnerName: 'Компания «Б»', tourTitle: 'Горелый & кратер', price: '12 000 ₽ за человека', date: '2027-01-15', people: 3,
      url: 'https://vedarai.ru/catalog/tours/201?date=2027-01-15&guests=3#booking',
    });
    expect(text.split('\n')).toEqual([
      '<b>Компания «Компания «Б»» ответила Ведару: возьмёт вас 15.01.2027</b>',
      'Тур «Горелый &amp; кратер» на 3 чел., 12 000 ₽ за человека.',
      'Это ответ на вопрос Ведара, ещё не бронь. Заявку вы оставляете сами: https://vedarai.ru/catalog/tours/201?date=2027-01-15&amp;guests=3#booking',
      'Имя и телефон получит только эта компания.',
    ]);
    expect(offerTookText({ partnerName: 'Б', tourTitle: 'Т', price: null, date: '2027-01-15', people: null, url: 'https://vedarai.ru/t' }))
      .toContain('Тур «Т», цена не указана.');
  });

  it('компании — исход каждого нажатия своими словами; «сообщено» только когда сообщено', () => {
    const say = (o: OfferAskOutcome) => offerAskReplyText(o);
    expect(say({ state: 'took', told: 'max', date: '2027-01-15', tourTitle: 'К кратеру' }))
      .toBe('Записал: «Беру». Человеку сообщено в MAX: ваша компания готова принять его 15.01.2027 — тур «К кратеру». Заявку он оставит сам — она придёт вам обычной заявкой с его контактами.');
    expect(say({ state: 'took', told: 'telegram', date: '2027-01-15', tourTitle: 'К кратеру' })).toContain('Человеку сообщено в Telegram');
    const silent: OfferAskOutcome[] = [
      { state: 'took', told: 'status', date: '2027-01-15', tourTitle: 'К кратеру' },
      { state: 'took', told: 'manager', date: '2027-01-15', tourTitle: 'К кратеру' },
      { state: 'took', told: 'outgrown' }, { state: 'took', told: 'unlisted' }, { state: 'took', told: 'unknown' }, { state: 'took', told: 'sending' },
      { state: 'declined' }, { state: 'already', answer: 'take' }, { state: 'not_yours' }, { state: 'date_passed' }, { state: 'failed' },
    ];
    for (const o of silent) expect(say(o), JSON.stringify(o)).not.toContain('Человеку сообщено');
    expect(say(silent[0]!)).toContain('увидит на странице своей заявки');
    // «Передан менеджеру» — только у исхода, где письмо менеджер принял.
    expect(say(silent[1]!)).toContain('ваш ответ передан менеджеру Ведара, чтобы он сообщил человеку');
    for (const o of silent.filter((x) => !(x.state === 'took' && x.told === 'manager'))) expect(say(o), JSON.stringify(o)).not.toContain('менеджер');
    expect(say({ state: 'took', told: 'outgrown' })).toContain('Ему ничего не отправлено.');
    expect(say({ state: 'took', told: 'unlisted' })).toContain('Ему ничего не отправлено.');
    // Отправка не уложилась в срок нажатия: ни «сообщено», ни «не отправлено» — «отправляется».
    expect(say({ state: 'took', told: 'sending' })).toContain('Сообщение человеку отправляется — дошло ли, пока неизвестно');
    expect(say({ state: 'took', told: 'sending' })).not.toContain('ничего не отправлено');
    // Название тура — ввод компании: в ответе оно экранировано, разметку не ломает.
    expect(say({ state: 'took', told: 'max', date: '2027-01-15', tourTitle: 'Горелый <b>& кратер' })).toContain('тур «Горелый &lt;b&gt;&amp; кратер»');
    expect(say({ state: 'declined' })).toBe('Записал: «Не могу». В списке этого человека вашей компании не будет.');
    expect(say({ state: 'already', answer: 'decline' })).toBe('Вы уже ответили на этот вопрос: «Не могу». Ответ один — второй раз не записываю.');
    for (const o of [{ state: 'not_yours' }, { state: 'date_passed' }] as OfferAskOutcome[]) expect(say(o)).toContain('Ничего не записал.');
    expect(say({ state: 'failed' })).toContain('Не удалось записать ответ');
    // Каждый исход — своя фраза: два разных исхода одними словами не говорятся.
    const all = [{ state: 'took', told: 'max', date: '2027-01-15', tourTitle: 'Т' } as OfferAskOutcome, ...silent].map(say);
    expect(new Set(all).size).toBe(all.length);
  });

  it('менеджеру о «Беру»: контакт не записан — так и сказано; заглушка без ПД; разметку ввод не ломает', () => {
    const m = managerTookText({
      leadId: LEAD, partnerName: 'Б <i>', tourTitle: 'Т', price: null, date: '2027-01-15', people: null,
      url: 'https://vedarai.ru/t?a=1&b=2', tried: ['telegram:timeout'],
    }, { name: null, phone: null });
    expect(m.text.split('\n')).toEqual([
      '<b>Другая компания ответила «Беру» — клиенту не сообщено, позвонить</b>',
      `Заявка <code>${LEAD}</code>: после отказа Ведар спросил другие компании. «Б &lt;i&gt;» ответила: возьмёт 15.01.2027 — тур «Т», цена не указана.`,
      'Это слово компании, ещё не бронь: заявку клиент оставляет ей сам — https://vedarai.ru/t?a=1&amp;b=2',
      '<b>Имя:</b> не записано',
      '<b>Телефон:</b> не записан',
      'Почему письмо: Telegram клиента сообщение не принял (timeout).',
      'На странице заявки клиента ответ компании стоит. ИИ-агенту клиента, если заявку создавал он, уведомление о «Беру» не уходит — он прочтёт ответ в статусе заявки.',
    ]);
    expect(m.stub.split('\n')).toHaveLength(3);
    expect(m.stub).not.toMatch(/Имя|Телефон:/);
  });

  it('отказавшему оператору — строка только о дошедших вопросах', () => {
    expect(offerAsksOperatorLine(0)).toBeNull();
    expect(offerAsksOperatorLine(1)).toContain('Одной другой компании');
    expect(offerAsksOperatorLine(3)).toBe('Другим компаниям с турами к этому месту (3) задан вопрос, возьмут ли они туриста на эту дату, — без его имени и телефона.');
  });
});

describe('спросить другие компании', () => {
  it('после «Нет мест»: по вопросу каждой названной компании — одной командой; в вопросе нет ПД; кнопки подписаны', async () => {
    const w = world();
    expect(await askOtherCompanies(LEAD, w.deps)).toEqual({ state: 'asked', created: 3, sent: 3 });
    // Список — тот же отбор, что у человека, с ответами по этой заявке.
    expect(w.offers.mock.calls[0]![0]).toEqual({ tourId: '70', date: '2027-01-15', people: 3, leadId: LEAD });
    expect(w.of(OFFER_ASKS_INSERT_SQL)[0]!.params).toEqual([LEAD, '2027-01-15', 3, [B, C, D], ['201', '202', '203']]);
    expect(w.pdAlert).toHaveBeenCalledTimes(3);
    for (const call of w.pdAlert.mock.calls) {
      const p = call[0] as unknown as { text: string; stub: string; buttons: Array<{ text: string; payload: string }>; to: unknown };
      // ПД в вопросе нет — текст один на оба канала.
      expect(p.stub).toBe(p.text);
      expect(p.text).toContain('Вопрос от Ведара — это не заявка');
      expect(p.text).toContain('на 15.01.2027, 3 чел.');
      expect(p.buttons.map((b) => b.text)).toEqual(['Беру', 'Не могу']);
      for (const b of p.buttons) expect(unwrapPress(b.payload, NOW).ok).toBe(true);
    }
    // Каждой компании — про её тур и с её номером вопроса.
    const toB = w.pdAlert.mock.calls.find((c) => (c[0] as { to: { maxChatId: unknown } }).to.maxChatId === '802')![0] as unknown as { text: string; buttons: Array<{ payload: string }> };
    expect(toB.text).toContain('тур «Горелый &amp; кратер»');
    expect(unwrapPress(toB.buttons[0]!.payload, NOW)).toEqual({ ok: true, payload: 'oq:y:11' });
    // Куда дошло — записано у каждого вопроса.
    expect(w.of(OFFER_ASK_SENT_SQL).map((r) => r.params).sort()).toEqual([['11', 'max', null], ['12', 'telegram', null], ['13', 'max', null]]);
  });

  it('кнопки в Telegram — только в чат, привязанный к карточке; личный Telegram аккаунта и «нет чата» — вопрос не уходит', async () => {
    const w = world({ reach: {
      [B]: reachOf({ telegramChatId: '902', telegramSource: 'partner', reachable: true }),
      [C]: reachOf({ telegramChatId: '903', telegramSource: 'user', reachable: true }),
      [D]: reachOf({}),
    } });
    expect(await askOtherCompanies(LEAD, w.deps)).toEqual({ state: 'asked', created: 3, sent: 1 });
    expect(w.pdAlert).toHaveBeenCalledTimes(1);
    const p = w.pdAlert.mock.calls[0]![0] as unknown as { to: unknown; stubActions: Array<{ text: string }>; buttons: unknown[] };
    expect(p.to).toEqual({ maxChatId: null, telegramChatId: '902' });
    expect(p.stubActions.map((b) => b.text)).toEqual(['Беру', 'Не могу']);
    // Почему не дошло — записано; строка вопроса остаётся, второй раз компанию не спросят.
    expect(w.of(OFFER_ASK_SENT_SQL).map((r) => r.params).sort()).toEqual([['11', 'telegram', null], ['12', null, 'no_channel'], ['13', null, 'no_channel']]);
  });

  it('в MAX карточки и в личный Telegram аккаунта: вопрос идёт в MAX, заглушка в чужой Telegram не откатывается', async () => {
    const w = world({ created: [{ id: '11', partner_id: B, tour_id: '201' }], reach: {
      [B]: reachOf({ maxChatId: '802', telegramChatId: '902', telegramSource: 'user', reachable: true }),
    } });
    await askOtherCompanies(LEAD, w.deps);
    const p = w.pdAlert.mock.calls[0]![0] as unknown as { to: unknown; stubActions: unknown[] };
    expect(p.to).toEqual({ maxChatId: '802', telegramChatId: null });
    expect(p.stubActions).toEqual([]);
  });

  it('когда не спрашивать: вид заявки не тот отказ — ни записи, ни сообщений', async () => {
    const silent: Array<[string, StatusRow | null]> = [
      ['оператор ещё не ответил', { ...ROW, lead_answer: null, lead_answer_id: null }],
      ['отказ по погоде', { ...ROW, lead_status: 'lost', lead_answer: 'decline', lead_decline_reason: 'weather' }],
      ['большая группа', { ...ROW, lead_group_over: true }],
      ['«другая дата»', { ...ROW, lead_status: 'contacted', lead_answer: 'other_date' }],
      ['бронь по заявке', { ...ROW, booking_status: 'confirmed', booking_date: '2027-01-15' }],
      ['своя проба или заявка без адресата', { ...ROW, lead_addressed: false }],
      ['дата прошла', { ...ROW, lead_requested_date: '2027-01-09' }],
      ['нет тура', { ...ROW, lead_tour_id: null }],
      ['заявки нет', null],
    ];
    for (const [name, row] of silent) {
      const w = world({ row });
      expect(await askOtherCompanies(LEAD, w.deps), name).toEqual({ state: 'skip' });
      expect(w.offers, name).not.toHaveBeenCalled();
      expect(w.of(OFFER_ASKS_INSERT_SQL), name).toHaveLength(0);
      expect(w.pdAlert, name).not.toHaveBeenCalled();
    }
  });

  it('повтор: вопросы уже заведены — никому второй раз не уходит', async () => {
    const w = world({ created: [] });
    expect(await askOtherCompanies(LEAD, w.deps)).toEqual({ state: 'asked', created: 0, sent: 0 });
    expect(w.pdAlert).not.toHaveBeenCalled();
    expect(OFFER_ASKS_INSERT_SQL).toContain('ON CONFLICT (lead_id, partner_id, ask_date) DO NOTHING');
  });

  it('других нет — «none»; список не прочитался — «failed»; ни то ни другое вопросов не заводит', async () => {
    const none = world();
    none.offers.mockResolvedValue({ state: 'none' });
    expect(await askOtherCompanies(LEAD, none.deps)).toEqual({ state: 'none' });
    const failed = world();
    failed.offers.mockResolvedValue({ state: 'failed' });
    expect(await askOtherCompanies(LEAD, failed.deps)).toEqual({ state: 'failed' });
    for (const w of [none, failed]) {
      expect(w.of(OFFER_ASKS_INSERT_SQL)).toHaveLength(0);
      expect(w.pdAlert).not.toHaveBeenCalled();
    }
  });

  it('не бросает: отправка упала, зависла, адрес не прочитался, база отказала — исход назван, остальные вопросы идут', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = world({ reach: {
      [B]: reachOf({ maxChatId: '802', reachable: true }),
      [C]: null,
      [D]: reachOf({ maxChatId: '804', reachable: true }),
    } });
    w.pdAlert.mockImplementation(async (p: { to?: { maxChatId?: unknown } }) => {
      if (p.to?.maxChatId === '802') throw new Error('boom');
      return new Promise(() => {});
    });
    expect(await askOtherCompanies(LEAD, { ...w.deps, timeoutMs: 20 })).toEqual({ state: 'asked', created: 3, sent: 0 });
    expect(w.of(OFFER_ASK_SENT_SQL).map((r) => r.params).sort()).toEqual([['11', null, 'exception'], ['12', null, 'reach_unknown'], ['13', null, 'timeout']]);
    // База не ответила на первом же чтении — «failed», а не исключение наружу.
    const broken = world();
    broken.q.mockRejectedValue(Object.assign(new Error('db'), { code: '57P01' }));
    expect(await askOtherCompanies(LEAD, broken.deps)).toEqual({ state: 'failed' });
    // В логах нет ни чата, ни текста вопроса.
    expect([...warn.mock.calls, ...error.mock.calls].flat().join(' ')).not.toMatch(/802|804|Горелый/);
    warn.mockRestore();
    error.mockRestore();
  });

  it('в пределах нажатия: строка оператору — о дошедших; срок вышел — строки нет, а не «задан вопрос»', async () => {
    const w = world();
    expect(await askOtherCompaniesWithinPress(LEAD, w.deps)).toContain('(3) задан вопрос');
    const none = world({ reach: {} });
    expect(await askOtherCompaniesWithinPress(LEAD, none.deps)).toBeNull();
    const skip = world({ row: { ...ROW, lead_addressed: false } });
    expect(await askOtherCompaniesWithinPress(LEAD, skip.deps)).toBeNull();
    // Срок рассылки вопросов короче срока сообщения человеку и длиннее нуля; одна отправка — со своим сроком.
    expect(OFFER_ASKS_PRESS_BUDGET_MS).toBeGreaterThan(0);
    expect(OFFER_ASKS_PRESS_BUDGET_MS).toBeLessThan(NOTICE_PRESS_BUDGET_MS);
    expect(OFFER_ASK_SEND_TIMEOUT_MS).toBeGreaterThan(OFFER_ASKS_PRESS_BUDGET_MS);
  });
});

describe('ответ компании', () => {
  const took = (w: ReturnType<typeof world>) => {
    w.offers.mockResolvedValue({ ...OFFERS, offers: [offer(B, 'Компания «Б»', '201', 'Горелый & кратер', 'take'), OFFERS.offers[1]] });
    return w;
  };

  it('право — в условии записи: вопрос этой компании, ответа ещё нет, дата впереди; кто нажал — из чата, не из кнопки', async () => {
    const w = world();
    await answerOfferAsk({ partnerId: B, askId: '11', answer: 'decline', via: 'telegram' }, w.deps);
    expect(w.of(OFFER_ASK_ANSWER_SQL)[0]!.params).toEqual(['11', B, 'decline', 'telegram', '2027-01-10']);
    expect(OFFER_ASK_ANSWER_SQL).toMatch(/WHERE id = \$1::bigint AND partner_id = \$2::uuid AND answer IS NULL AND ask_date >= \$5::date/);
  });

  it('«Не могу»: записано, человеку ничего не уходит', async () => {
    const w = world();
    expect(await answerOfferAsk({ partnerId: C, askId: '12', answer: 'decline', via: 'max' }, w.deps)).toEqual({ state: 'declined' });
    expect(w.sendMax).not.toHaveBeenCalled();
    expect(w.sendTelegram).not.toHaveBeenCalled();
    expect(w.of(OFFER_ASK_TOLD_SQL)).toHaveLength(0);
    expect(w.of(REQUEST_STATUS_BY_LEAD_SQL)).toHaveLength(0);
  });

  it('«Беру»: человеку сообщение в его чат — чьё слово, тур, ссылка; отметка «сообщено» — после принятого сообщения', async () => {
    const w = took(world());
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, w.deps))
      .toEqual({ state: 'took', told: 'max', date: '2027-01-15', tourTitle: 'Горелый & кратер' });
    expect(w.sendMax).toHaveBeenCalledTimes(1);
    const [chat, text, buttons] = w.sendMax.mock.calls[0] as unknown as [string, string, unknown[]];
    expect(chat).toBe('555');
    expect(buttons).toEqual([]);
    expect(text).toContain('Компания «Компания «Б»» ответила Ведару: возьмёт вас 15.01.2027');
    expect(text).toContain('https://vedarai.ru/catalog/tours/201?date=2027-01-15&amp;guests=3#booking');
    expect(text).toContain('ещё не бронь');
    expect(w.of(OFFER_ASK_TOLD_SQL)[0]!.params).toEqual(['11', 'max']);
    // Список читается с заявкой: «возьмёт» берётся из записанного ответа, а не из нажатия.
    expect(w.offers.mock.calls[0]![0]).toEqual({ tourId: '70', date: '2027-01-15', people: 3, leadId: LEAD });
  });

  it('первый чат не принял — пробуется следующий; принял — менеджеру письма нет', async () => {
    const two = took(world({ targets: [{ channel: 'max', chat_id: '555' }, { channel: 'telegram', chat_id: '777' }] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    two.sendMax.mockResolvedValue({ ok: false, code: 'bad_id' } as never);
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, two.deps)).toMatchObject({ state: 'took', told: 'telegram' });
    expect(two.of(OFFER_ASK_TOLD_SQL)[0]!.params).toEqual(['11', 'telegram']);
    // Человек узнал сам — контакт не читается и менеджеру ничего не уходит.
    expect(two.pdAlert).not.toHaveBeenCalled();
    expect(two.of(NOTICE_CONTACT_SQL)).toHaveLength(0);
    expect(two.of(OFFER_ASK_MANAGER_SQL)).toHaveLength(0);
    // В логе — канал, но не чат.
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/555|777/);
    warn.mockRestore();
  });

  it('чата нет или не принял никто — письмо менеджеру: контакт только в MAX, в заглушке его нет; компании — «передан менеджеру»', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const none = took(world({ targets: [] }));
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, none.deps))
      .toEqual({ state: 'took', told: 'manager', date: '2027-01-15', tourTitle: 'Горелый & кратер' });
    expect(none.sendMax).not.toHaveBeenCalled();
    expect(none.pdAlert).toHaveBeenCalledTimes(1);
    const letter = none.pdAlert.mock.calls[0]![0] as unknown as { text: string; stub: string; to?: unknown; buttons: Array<{ text: string; url: string }> };
    // Адресата нет — письмо уходит менеджеру, а не компании, нажавшей «Беру».
    expect(letter.to).toBeUndefined();
    expect(letter.text).toContain('Другая компания ответила «Беру» — клиенту не сообщено, позвонить');
    expect(letter.text).toContain(`Заявка <code>${LEAD}</code>`);
    expect(letter.text).toContain('«Компания «Б»» ответила: возьмёт 15.01.2027 — тур «Горелый &amp; кратер» на 3 чел., 12 000 ₽ за человека.');
    expect(letter.text).toContain('<b>Имя:</b> Анна &lt;Петрова&gt;');
    expect(letter.text).toContain('<b>Телефон:</b> +7 900 123-45-67');
    expect(letter.text).toContain('Почему письмо: чата с Ведаром у клиента нет.');
    expect(letter.text).toContain('ещё не бронь');
    // Заглушка для Telegram: что случилось — да, имя и телефон — нет.
    expect(letter.stub).toContain('Другая компания ответила «Беру»');
    expect(letter.stub).toContain('в Telegram они не передаются');
    expect(letter.stub).not.toMatch(/Анна|Петрова|900|123-45-67/);
    expect(letter.buttons.map((b) => b.url)).toEqual([expect.stringMatching(/\/hub\/admin\/queue$/), expect.stringMatching(/\/hub\/admin\/leads$/)]);
    // Отметка — про менеджера; «человек узнал» не записано.
    expect(none.of(OFFER_ASK_MANAGER_SQL)[0]!.params).toEqual(['11', 'max']);
    expect(none.of(OFFER_ASK_TOLD_SQL)).toHaveLength(0);

    const refused = took(world({ targets: [{ channel: 'max', chat_id: '555' }, { channel: 'telegram', chat_id: '777' }] }));
    refused.sendMax.mockResolvedValue({ ok: false, code: 'bad_id 555' } as never);
    refused.sendTelegram.mockResolvedValue({ ok: false, code: 'api_error' } as never);
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, refused.deps)).toMatchObject({ state: 'took', told: 'manager' });
    const why = (refused.pdAlert.mock.calls[0]![0] as unknown as { text: string }).text;
    // Код не из списка в письмо не идёт: в свободном тексте ошибки мог бы стоять id чата.
    expect(why).toContain('Почему письмо: MAX клиента сообщение не принял (api_error); Telegram клиента сообщение не принял (api_error).');
    expect(why).not.toMatch(/555|777/);
    warn.mockRestore();
  });

  it('письмо менеджеру ушло заглушкой в Telegram — так и записано; не принял никто — «увидит в статусе», «передан менеджеру» не говорится', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = took(world({ targets: [] }));
    stub.pdAlert.mockResolvedValue({ channel: 'telegram-stub', delivered: false, reason: 'max_failed' } as never);
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, stub.deps)).toMatchObject({ state: 'took', told: 'manager' });
    expect(stub.of(OFFER_ASK_MANAGER_SQL)[0]!.params).toEqual(['11', 'telegram-stub']);

    for (const fail of [
      async () => ({ channel: 'none', delivered: false, reason: 'no_channel' }),
      async () => ({ channel: 'max', delivered: false, reason: 'api_error' }),
      async () => { throw new Error('boom'); },
      () => new Promise<never>(() => undefined),
    ]) {
      const w = took(world({ targets: [] }));
      w.pdAlert.mockImplementation(fail as never);
      expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, { ...w.deps, timeoutMs: 20 }))
        .toEqual({ state: 'took', told: 'status', date: '2027-01-15', tourTitle: 'Горелый & кратер' });
      expect(w.of(OFFER_ASK_MANAGER_SQL)).toHaveLength(0);
    }
    // Письмо принято, а отметка не записалась — менеджер его получил, исход «передано» правдив.
    const unrecorded = took(world({ targets: [] }));
    const base = unrecorded.q.getMockImplementation()!;
    unrecorded.q.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === OFFER_ASK_MANAGER_SQL) throw Object.assign(new Error('db'), { code: '57P01' });
      return base(sql, params);
    });
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, unrecorded.deps)).toMatchObject({ state: 'took', told: 'manager' });
    error.mockRestore();
  });

  it('заявка с тех пор изменилась — «Беру» записано, человеку ничего не уходит', async () => {
    const outgrown: Array<[string, StatusRow | null]> = [
      ['человека приняли: бронь', { ...ROW, booking_status: 'confirmed', booking_date: '2027-01-15' }],
      ['человек сменил дату', { ...ROW, lead_requested_date: '2027-01-20' }],
      ['заявку вернули в работу', { ...ROW, lead_status: 'contacted' }],
      ['человек отменил', { ...ROW, lead_status: 'cancelled' }],
      ['заявки нет', null],
    ];
    for (const [name, row] of outgrown) {
      const w = took(world({ row }));
      expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, w.deps), name).toEqual({ state: 'took', told: 'outgrown' });
      expect(w.sendMax, name).not.toHaveBeenCalled();
      expect(w.of(OFFER_ASK_TOLD_SQL), name).toHaveLength(0);
      // Звонить не о чем: «возьмёт на прежнюю дату» человеку уже не нужно.
      expect(w.pdAlert, name).not.toHaveBeenCalled();
      expect(w.of(NOTICE_CONTACT_SQL), name).toHaveLength(0);
    }
  });

  it('тур сейчас не назвать (снят с витрины, дата закрыта) — «unlisted»; список не прочитался — «unknown»; человеку ничего', async () => {
    const unlisted = world();
    // В списке компании нет отметки «возьмёт» — отбор её тур не называет.
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, unlisted.deps)).toEqual({ state: 'took', told: 'unlisted' });
    const gone = world();
    gone.offers.mockResolvedValue({ state: 'none' });
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, gone.deps)).toEqual({ state: 'took', told: 'unlisted' });
    const unknown = world();
    unknown.offers.mockResolvedValue({ state: 'failed' });
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, unknown.deps)).toEqual({ state: 'took', told: 'unknown' });
    for (const w of [unlisted, gone, unknown]) {
      expect(w.sendMax).not.toHaveBeenCalled();
      // Тур не назвать — менеджеру звонить не с чем.
      expect(w.pdAlert).not.toHaveBeenCalled();
    }
  });

  it('не записалось: чужой вопрос, уже отвечено, дата прошла, сбой базы — у каждого своё слово, человеку ничего', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: Array<[Parameters<typeof world>[0], OfferAskOutcome]> = [
      [{ answered: null, was: null }, { state: 'not_yours' }],
      [{ answered: null, was: { answer: 'take', passed: false } }, { state: 'already', answer: 'take' }],
      [{ answered: null, was: { answer: 'decline', passed: true } }, { state: 'already', answer: 'decline' }],
      [{ answered: null, was: { answer: null, passed: true } }, { state: 'date_passed' }],
      [{ answered: null, was: { answer: null, passed: false } }, { state: 'failed' }],
    ];
    for (const [over, want] of cases) {
      const w = world(over);
      expect(await answerOfferAsk({ partnerId: A, askId: '11', answer: 'take', via: 'max' }, w.deps), JSON.stringify(want)).toEqual(want);
      expect(w.of(OFFER_ASK_READ_SQL)[0]!.params).toEqual(['11', A, '2027-01-10']);
      expect(w.sendMax).not.toHaveBeenCalled();
    }
    const broken = world();
    broken.q.mockRejectedValue(Object.assign(new Error('db'), { code: '57P01' }));
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, broken.deps)).toEqual({ state: 'failed' });
    error.mockRestore();
  });

  it('зависший чат человека нажатие «Беру» не держит: после срока — «отправляется», ответ записан', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = took(world());
    w.sendMax.mockImplementation(() => new Promise<never>(() => undefined));
    const r = await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, { ...w.deps, pressMs: 30, timeoutMs: 5_000 });
    expect(r).toEqual({ state: 'took', told: 'sending' });
    expect(w.of(OFFER_ASK_ANSWER_SQL)).toHaveLength(1);
    // «Сообщено» в базу не записано: отправка ещё идёт.
    expect(w.of(OFFER_ASK_TOLD_SQL)).toHaveLength(0);
    warn.mockRestore();
  });

  it('сбой после записи «Беру» ответа не отменяет: человеку не сообщено — так и сказано', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = took(world());
    w.q.mockImplementation(async (sql: string) => {
      if (sql === OFFER_ASK_ANSWER_SQL) return { rows: [{ lead_id: LEAD, tour_id: '201', ask_date: '2027-01-15', people: 3 }] };
      throw Object.assign(new Error('db'), { code: '57P01' });
    });
    expect(await answerOfferAsk({ partnerId: B, askId: '11', answer: 'take', via: 'max' }, w.deps)).toEqual({ state: 'took', told: 'unknown' });
    expect(w.sendMax).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
