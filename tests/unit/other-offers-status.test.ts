// @vitest-environment node
/**
 * «Другие компании к месту на дату» в виде заявки (план «после отказа», этап
 * 4а, второй срез): ответ get_request_status ИИ-агенту и страница заявки.
 *
 * Держит: называть ли компании — то же правило, что у сообщения человеку в чат
 * (после «Нет мест» и отказа не по погоде; не у большой группы, не у «другой
 * даты», не у причины на стороне клиента, не у заявки без тура и даты, не на
 * прошедшую дату); три исхода чтения и «не про эту заявку» различимы (§4.0);
 * в чтение идут только тур, дата и число людей; странице слова для агента не
 * уходят; каждое поле ответа объявлено в схеме инструмента.
 *
 * Всё — вызовом: правило на строках заявки, чтение с подменённым загрузчиком,
 * дверь страницы — её обработчиком.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query, loadOtherOffers } = vi.hoisted(() => ({ query: vi.fn(), loadOtherOffers: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
vi.mock('@/lib/requests/other-offers', () => ({ loadOtherOffers }));

import { buildRequestView, readRequestStatus, runRequestStatusTool, REQUEST_STATUS_SQL, type StatusRow } from '@/lib/mcp/request-status';
import { GET_REQUEST_STATUS_TOOL, OTHER_OFFERS_STATES } from '@/lib/mcp/request-status-schema';
import { otherOffersAsk, pageOtherOffers, readStatusOtherOffers, STATUS_OFFERS_TIMEOUT_MS } from '@/lib/requests/other-offers-status';
import { NOTICE_FACTS_SQL } from '@/lib/requests/answer-notice';
import { answerWantsOffers, type NoticeAnswer } from '@/lib/requests/answer-notice-text';
import { DECLINE_REASONS, type DeclineReason } from '@/lib/requests/chat-answer-buttons';
import { CLIENT_LOST_REASONS } from '@/lib/leads/lost-reason';
import { OFFER_ORDER_NOTE_ON_DATE_RU } from '@/lib/tours/offer-order';
import { GET as statusGET } from '@/app/api/requests/status/route';

/** Сегодня по Камчатке — 10.01.2027: заявка на 15.01 впереди. */
const NOW = Date.parse('2027-01-10T00:00:00Z');
const TODAY = '2027-01-10';
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

const LEAD: StatusRow = {
  key_id: 'K', tool_name: 'create_booking_request', lead_id: 'L', seat_request_id: null,
  lead_status: 'new', route_title: 'Вулкан Горелый', lead_requested_date: '2027-01-15', lead_tour: 'Вулкан Горелый',
  lead_tour_id: '70', lead_people: 3, lead_participants: 3,
  booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
  seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null, seat_tour: null,
  lead_consent_at: null, lead_consent_source: null, seat_consent_at: null, seat_consent_source: null,
  stay_request_id: null, stay_accommodation_id: null, stay_name: null, stay_check_in: null, stay_check_out: null, stay_guests: null,
  stay_owner_channel: null, stay_platform_channel: null, stay_delivery_recorded_at: null, stay_consent_at: null, stay_consent_source: null,
  opens_chat: true, lead_addressed: true,
};
const NO_SEATS: StatusRow = { ...LEAD, lead_answer: 'no_seats', lead_answer_id: '77' };
const declined = (reason: DeclineReason): StatusRow => ({ ...LEAD, lead_status: 'lost', lead_answer: 'decline', lead_decline_reason: reason, lead_answer_id: '78' });
const closed = (reason: string): StatusRow => ({ ...LEAD, lead_status: 'lost', lead_lost_reason: reason, lead_closed_id: '901' });

/** Правило на строке заявки — через тот же вид, что получает читатель. */
const ask = (row: StatusRow, today = TODAY) => otherOffersAsk(row, buildRequestView(row, NOW), today);

const FORM_A = 'https://vedarai.ru/catalog/tours/gorely-za-den?date=2027-01-15&guests=3#booking';
const FORM_B = 'https://vedarai.ru/catalog/tours/202?date=2027-01-15&guests=3#booking';
const PLACE_URL = 'https://vedarai.ru/places/gorely#tours';
const OK = {
  state: 'ok' as const, placeName: 'Вулкан Горелый', placeUrl: PLACE_URL,
  offers: [
    { partnerName: 'Компания А', tourId: '201', title: 'Горелый за день', price: '12 000 ₽ за человека', seats: 'calendar' as const, url: FORM_A, moreTours: 2 },
    { partnerName: 'Вторая', tourId: '202', title: 'К кратеру', price: null, seats: 'by_request' as const, url: FORM_B, moreTours: 0 },
  ],
  more: 1,
};

beforeEach(() => {
  query.mockReset();
  loadOtherOffers.mockReset();
  vi.useRealTimers();
});

describe('когда называть другие компании', () => {
  it('после «Нет мест» — спрашиваем: отказанный тур, дата заявки, число людей', () => {
    expect(ask(NO_SEATS)).toEqual({ tourId: '70', date: '2027-01-15', people: 3 });
  });

  it('после «Отказать» — у каждой причины, кроме погоды и безопасности: то же место в тот же день называть нельзя', () => {
    for (const reason of DECLINE_REASONS) {
      const got = ask(declined(reason));
      if (reason === 'weather') expect(got).toBeNull();
      else expect(got).toEqual({ tourId: '70', date: '2027-01-15', people: 3 });
    }
  });

  it('закрытие заявки продавцом с причиной — как отказ кнопкой; причина на стороне клиента — не отказ продавца', () => {
    for (const reason of DECLINE_REASONS) {
      const got = ask(closed(reason));
      if (reason === 'weather') expect(got).toBeNull();
      else expect(got).toEqual({ tourId: '70', date: '2027-01-15', people: 3 });
    }
    for (const reason of CLIENT_LOST_REASONS) expect(ask(closed(reason))).toBeNull();
  });

  it('ответ не отказ — не спрашиваем: «берёт», «уточнит», «свяжется сам», «другая дата»', () => {
    for (const answer of ['accept', 'clarify', 'self', 'other_date']) {
      expect(ask({ ...LEAD, lead_status: answer === 'accept' || answer === 'other_date' ? 'contacted' : 'new', lead_answer: answer, lead_answer_id: '79' })).toBeNull();
    }
  });

  it('заявка закрыта без записанного ответа — причина неизвестна, и компании не называются', () => {
    const row: StatusRow = { ...LEAD, lead_status: 'lost' };
    expect(buildRequestView(row, NOW).state).toBe('declined');
    expect(ask(row)).toBeNull();
  });

  it('вид уже не из отказа — не спрашиваем: бронь, заявку вернули в работу', () => {
    expect(ask({ ...NO_SEATS, booking_status: 'confirmed', booking_date: '2027-01-15' })).toBeNull();
    expect(ask({ ...NO_SEATS, lead_status: 'contacted' })).toBeNull();
  });

  it('большая группа, которую после отказа увидят другие операторы, — без списка: её заявка уже у них', () => {
    expect(ask({ ...NO_SEATS, lead_group_over: true })).toBeNull();
    expect(ask({ ...declined('seats'), lead_group_over: true })).toBeNull();
    expect(ask({ ...closed('seats'), lead_group_over: true })).toBeNull();
  });

  it('машина, прокат и жильё — свои витрины: списка туров нет', () => {
    expect(ask({ ...LEAD, tool_name: 'request_charter', lead_status: 'lost', lead_partner_answer: 'decline', lead_partner_answer_id: '5' })).toBeNull();
    expect(ask({ ...LEAD, tool_name: 'create_car_rental_request', lead_partner_answer: 'decline', lead_partner_answer_id: '6' })).toBeNull();
  });

  it('нет тура или даты, дата не той формы, дата прошла — не спрашиваем; сегодняшняя — спрашиваем', () => {
    expect(ask({ ...NO_SEATS, lead_tour_id: null })).toBeNull();
    expect(ask({ ...NO_SEATS, lead_requested_date: null })).toBeNull();
    expect(ask({ ...NO_SEATS, lead_requested_date: '15.01.2027' })).toBeNull();
    expect(ask(NO_SEATS, '2027-01-16')).toBeNull();
    expect(ask(NO_SEATS, '2027-01-15')).toEqual({ tourId: '70', date: '2027-01-15', people: 3 });
  });

  it('число людей — как в заявке, до сотен; не записано — null, а не выдуманное', () => {
    expect(ask({ ...NO_SEATS, lead_people: 100 })?.people).toBe(100);
    expect(ask({ ...NO_SEATS, lead_people: null })?.people).toBeNull();
    expect(ask({ ...NO_SEATS, lead_people: 0 })?.people).toBeNull();
  });

  it('то же правило, что у сообщения человеку в чат: статус и чат одной заявки не расходятся', () => {
    const cases: Array<{ answer: NoticeAnswer; reason: DeclineReason | null; group: boolean; row: StatusRow }> = [];
    for (const group of [false, true]) {
      cases.push({ answer: 'no_seats', reason: null, group, row: { ...NO_SEATS, lead_group_over: group } });
      for (const reason of DECLINE_REASONS) cases.push({ answer: 'decline', reason, group, row: { ...declined(reason), lead_group_over: group } });
    }
    expect(cases).toHaveLength(12);
    for (const c of cases) {
      // Группу после отказа не по погоде увидят другие операторы — тем же правилом, что в сообщении.
      const groupPassedOn = c.group && (c.answer === 'no_seats' || c.reason !== 'weather');
      const inChat = answerWantsOffers({ kind: 'tour', answer: c.answer, reason: c.reason, groupPassedOn });
      expect(ask(c.row) !== null, `${c.answer}/${c.reason}/группа ${c.group}`).toBe(inChat);
    }
  });

  it('тур и число людей статус читает так же, как сообщение человеку', () => {
    expect(REQUEST_STATUS_SQL).toContain('lt.id::text AS lead_tour_id');
    const people = "CASE WHEN l.source_data->>'participants' ~ '^[0-9]{1,3}$' THEN (l.source_data->>'participants')::int END";
    expect(REQUEST_STATUS_SQL).toContain(`${people} AS lead_people`);
    expect(NOTICE_FACTS_SQL).toContain(`${people} AS people`);
  });
});

describe('чтение: три исхода и «не про эту заявку»', () => {
  const core = (row: StatusRow) => buildRequestView(row, NOW);
  const deps = { load: loadOtherOffers, now: () => NOW };

  it('названы: компании тем же порядком, что отдал загрузчик; агенту сказано, что это и что с этим делать', async () => {
    loadOtherOffers.mockResolvedValue(OK);
    const o = await readStatusOtherOffers(NO_SEATS, core(NO_SEATS), deps);
    expect(o).toMatchObject({
      state: 'listed', place: 'Вулкан Горелый', place_url: PLACE_URL, date: '2027-01-15', participants: 3, more_companies: 1,
      offers: [
        { company: 'Компания А', tour: 'Горелый за день', tour_id: '201', price: '12 000 ₽ за человека', seats: 'calendar', url: FORM_A, more_tours: 2 },
        { company: 'Вторая', tour: 'К кратеру', tour_id: '202', price: null, seats: 'by_request', url: FORM_B, more_tours: 0 },
      ],
    });
    expect(o!.how).toContain('не ответ этих компаний');
    expect(o!.how).toContain('create_booking_request');
    expect(o!.how).toContain('только после его согласия');
    expect(o!.how).toContain('компанию выбирает человек, не вы');
    expect(o!.how).toContain(OFFER_ORDER_NOTE_ON_DATE_RU);
    expect(o!.how).not.toMatch(/рекоменд|выгодн|лучший/i);
  });

  it('в чтение идут только тур, дата и число людей — ни номера заявки, ни имени, ни телефона', async () => {
    loadOtherOffers.mockResolvedValue({ state: 'none' });
    await readStatusOtherOffers(NO_SEATS, core(NO_SEATS), deps);
    expect(loadOtherOffers).toHaveBeenCalledTimes(1);
    expect(loadOtherOffers.mock.calls[0]![0]).toEqual({ tourId: '70', date: '2027-01-15', people: 3 });
  });

  it('число людей не записано — места считаются на одного, а в ответе стоит null, не единица', async () => {
    loadOtherOffers.mockResolvedValue(OK);
    const row = { ...NO_SEATS, lead_people: null };
    const o = await readStatusOtherOffers(row, core(row), deps);
    expect(loadOtherOffers.mock.calls[0]![0]).toEqual({ tourId: '70', date: '2027-01-15', people: 1 });
    expect(o!.participants).toBeNull();
  });

  it('не найдены — «none» со словами «не нашёл», списка нет', async () => {
    loadOtherOffers.mockResolvedValue({ state: 'none' });
    const o = await readStatusOtherOffers(NO_SEATS, core(NO_SEATS), deps);
    expect(o).toMatchObject({ state: 'none', place: null, place_url: null, offers: [], more_companies: 0, date: '2027-01-15', participants: 3 });
    expect(o!.how).toContain('не нашёл');
    expect(o!.how).toContain('get_tours');
  });

  it('не прочиталось — «failed», и это не «не нашёл»: загрузчик сказал сбой, бросил или завис', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadOtherOffers.mockResolvedValueOnce({ state: 'failed' });
    const a = await readStatusOtherOffers(NO_SEATS, core(NO_SEATS), deps);
    loadOtherOffers.mockRejectedValueOnce(new Error('boom'));
    const b = await readStatusOtherOffers(NO_SEATS, core(NO_SEATS), deps);
    loadOtherOffers.mockReturnValueOnce(new Promise(() => {}));
    const c = await readStatusOtherOffers(NO_SEATS, core(NO_SEATS), { ...deps, timeoutMs: 20 });
    for (const o of [a, b, c]) {
      expect(o).toMatchObject({ state: 'failed', offers: [], place: null });
      expect(o!.how).toContain('не значит, что их нет');
      expect(o!.how).not.toContain('не нашёл');
    }
    // Бросил и завис — названо в логе, без данных заявки.
    expect(warn.mock.calls.map((x) => String(x[0]))).toEqual([
      expect.stringContaining('(exception)'), expect.stringContaining('(timeout)'),
    ]);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/\bL\b|70|2027-01-15/);
    warn.mockRestore();
  });

  it('срок чтения не длиннее пяти секунд: статус читают живьём', () => {
    expect(STATUS_OFFERS_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('не про эту заявку — null, и загрузчик не зовётся', async () => {
    for (const row of [LEAD, declined('weather'), { ...NO_SEATS, lead_group_over: true }, { ...NO_SEATS, lead_tour_id: null }]) {
      expect(await readStatusOtherOffers(row, core(row), deps)).toBeNull();
    }
    expect(loadOtherOffers).not.toHaveBeenCalled();
  });

  it('состояния ответа — те же, что объявлены в схеме', async () => {
    const seen = new Set<string>();
    for (const value of [OK, { state: 'none' as const }, { state: 'failed' as const }]) {
      loadOtherOffers.mockResolvedValueOnce(value);
      seen.add((await readStatusOtherOffers(NO_SEATS, core(NO_SEATS), deps))!.state);
    }
    expect([...seen].sort()).toEqual([...OTHER_OFFERS_STATES].sort());
  });
});

describe('get_request_status и страница заявки', () => {
  /** Строка базы на чтение статуса; отметку «ответ дошёл» база принимает молча. */
  const serve = (row: StatusRow) => query.mockImplementation(async (sql: string) => (sql === REQUEST_STATUS_SQL ? { rows: [row] } : { rows: [], rowCount: 0 }));

  it('агент после «Нет мест» получает other_offers — и все его поля объявлены в схеме', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    serve(NO_SEATS);
    loadOtherOffers.mockResolvedValue(OK);
    const obj = JSON.parse(await runRequestStatusTool({ key: KEY })) as { state: string; next: string; other_offers: Record<string, unknown> & { offers: Array<Record<string, unknown>> } };
    expect(obj.state).toBe('declined');
    expect(obj.other_offers.state).toBe('listed');
    expect(obj.other_offers.offers.map((x) => x.company)).toEqual(['Компания А', 'Вторая']);
    const schema = GET_REQUEST_STATUS_TOOL.outputSchema.properties.other_offers;
    expect(Object.keys(obj.other_offers).sort()).toEqual(Object.keys(schema.properties).sort());
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    for (const offer of obj.other_offers.offers) {
      expect(Object.keys(offer).sort()).toEqual(Object.keys(schema.properties.offers.items.properties).sort());
    }
    expect(Object.keys(obj).sort()).toEqual(Object.keys(GET_REQUEST_STATUS_TOOL.outputSchema.properties).sort());
  });

  it('вид не отказ — загрузчик не зовётся, поле null', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    serve(LEAD);
    const v = await readRequestStatus(KEY, { reader: 'agent' });
    expect(v.state).toBe('awaiting_operator');
    expect(v.other_offers).toBeNull();
    expect(loadOtherOffers).not.toHaveBeenCalled();
  });

  it('список не прочитался — статус заявки всё равно отдан', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serve(NO_SEATS);
    loadOtherOffers.mockRejectedValue(new Error('boom'));
    const v = await readRequestStatus(KEY, { reader: 'agent' });
    expect(v).toMatchObject({ state: 'declined', human: 'Оператор ответил: на 15.01.2027 мест нет.', other_offers: { state: 'failed' } });
    warn.mockRestore();
  });

  it('странице — тот же список без слов для агента', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    serve(NO_SEATS);
    loadOtherOffers.mockResolvedValue(OK);
    const res = await statusGET(new NextRequest(`http://localhost/api/requests/status?k=${KEY}`, { headers: { 'x-forwarded-for': '203.0.113.7' } }));
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { other_offers: Record<string, unknown> & { offers: unknown[] } } };
    expect(data.other_offers).toMatchObject({ state: 'listed', place: 'Вулкан Горелый', date: '2027-01-15', participants: 3, more_companies: 1 });
    expect(data.other_offers.offers).toHaveLength(2);
    expect(data.other_offers).not.toHaveProperty('how');
    expect(JSON.stringify(data)).not.toContain('create_booking_request');
  });

  it('pageOtherOffers: нет списка — null; есть — всё, кроме how', () => {
    expect(pageOtherOffers(null)).toBeNull();
    expect(pageOtherOffers(undefined)).toBeNull();
    const o = { state: 'none' as const, place: null, place_url: null, date: '2027-01-15', participants: 2, offers: [], more_companies: 0, how: 'слова агенту' };
    expect(pageOtherOffers(o)).toEqual({ state: 'none', place: null, place_url: null, date: '2027-01-15', participants: 2, offers: [], more_companies: 0 });
  });
});
