/**
 * Очередь менеджера (план «после отказа», этап 3б): клиенты, которым после
 * отказа нужен звонок или замена, одним списком, и отметка «Взял».
 *
 * До этого среза такие случаи приходили менеджеру тремя сообщениями в два
 * мессенджера и нигде не лежали списком; отметки, что случай кто-то взял, не
 * было. Судится поведением:
 *  - три источника читаются независимо: отказ одного — «не прочитался», а не
 *    «никого нет», и остальные он не прячет (§4.0);
 *  - отказ стоит в очереди, только пока вид заявки построен из него: бронь,
 *    новая дата, возврат в работу — случая в очереди нет. Правило то же, что
 *    решает, слать ли письмо менеджеру (viewHolds), и здесь оно настоящее;
 *  - сверка не удалась — источник «не прочитался»: список, в котором могут
 *    стоять перекрытые бронью отказы, хуже отсутствующего;
 *  - «Взял» ставится только на случай, который в очереди стоит, один раз, и
 *    говорит, кто взял раньше;
 *  - экран: сбой назван сбоем, пусто — пустым, телефон — ссылкой для звонка,
 *    «Взял» уходит запросом с родом и номером случая.
 * Запросы на настоящем PostgreSQL — tests/integration/request-chat.pg.test.ts
 * (сцена «очередь менеджера»), дверь API — tests/unit/manager-queue-route.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn(async () => { throw new Error('общий пул в этих проверках не зовётся'); }) },
}));

import {
  MANAGER_QUEUE_SINCE, QUEUE_KINDS, QUEUE_NOTICES_SQL, QUEUE_RELEASE_SQL, QUEUE_SOURCE_LIMIT, QUEUE_STAY_SQL,
  QUEUE_SUBJECT_SQL, QUEUE_TAKEN_DAYS, QUEUE_TAKE_READ_SQL, QUEUE_VEHICLE_SQL,
  isQueueSubjectId, loadManagerQueue, queueTakeSql, releaseQueueItem, takeQueueItem,
  type ManagerQueue, type NoticeItem, type StayItem, type VehicleItem,
} from '@/lib/manager-queue/queue';
import { REQUEST_STATUS_BY_LEADS_SQL, type StatusRow } from '@/lib/mcp/request-status';
import {
  QUEUE_SECTION, kamchatkaStamp, queueRequestId, queueStateLines, queueSubjectLine, ruDate, takeLine,
} from '@/lib/manager-queue/words';
import { MANAGER_QUEUE_PATH, managerQueueUrl, withQueueLine } from '@/lib/manager-queue/link';
import ManagerQueueClient from '@/app/hub/admin/queue/_ManagerQueueClient';

// ── Подменная база: ответ по самому запросу, счёт вызовов ─────────────────────

type Rows = Array<Record<string, unknown>>;
type Handler = (params: unknown[]) => Rows;

function fakeDb(handlers: Array<[sql: string, h: Handler]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    const found = handlers.find(([s]) => s === sql);
    if (!found) throw new Error(`неожиданный запрос: ${sql.trim().slice(0, 70)}`);
    const rows = found[1](params);
    return { rows, rowCount: rows.length };
  };
  const count = (sql: string) => calls.filter((c) => c.sql === sql).length;
  return { query, calls, count };
}
const dbError = (code: string): never => { throw Object.assign(new Error('отказ базы'), { code }); };

const lead = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = '11111111-1111-4111-8111-111111111111';
const STAY = '22222222-2222-4222-8222-222222222222';

/** Строка вида заявки: по умолчанию — заявка на тур, ответа нет. */
function st(leadId: string, patch: Partial<StatusRow> & Record<string, unknown> = {}): StatusRow {
  return {
    key_id: null, tool_name: 'create_booking_request', lead_id: leadId, seat_request_id: null,
    lead_status: 'new', route_title: null, booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
    seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null,
    seat_tour: null, lead_consent_at: null, lead_consent_source: null, seat_consent_at: null, seat_consent_source: null,
    stay_request_id: null, stay_accommodation_id: null, stay_name: null, stay_check_in: null, stay_check_out: null, stay_guests: null,
    stay_owner_channel: null, stay_platform_channel: null, stay_delivery_recorded_at: null, stay_consent_at: null, stay_consent_source: null,
    opens_chat: true, lead_addressed: true,
    ...patch,
  } as StatusRow;
}

const noticeRow = (id: string, leadId: string, patch: Record<string, unknown> = {}) => ({
  id, happened_at: new Date('2026-11-12T03:10:00Z'), answer: 'decline', decline_reason: 'seats', manager_channel: 'max',
  answer_id: null, activity_id: null, activity_action: null,
  lead_id: leadId, contact_name: 'Анна', contact_phone: '+79990000001', lead_status: 'lost',
  route_title: 'Мутновский', req_date: '2026-12-02', people: '2', partner_name: 'Оператор',
  taken_at: null, taken_via: null, taken_by_name: null, is_taken: false,
  ...patch,
});
const vehicleRow = (id: string, leadId: string, patch: Record<string, unknown> = {}) => ({
  id, happened_at: new Date('2026-11-12T04:00:00Z'), vehicle_kind: 'charter', vehicle_title: 'Елизово — Мутновский',
  date_from: '2026-12-05', date_to: '2026-12-06',
  lead_id: leadId, contact_name: 'Борис', contact_phone: '+79990000002', lead_status: 'lost',
  partner_name: 'Перевозчик', notice_state: 'delivered',
  taken_at: null, taken_via: null, taken_by_name: null, is_taken: false,
  ...patch,
});
const stayRow = (id: string, patch: Record<string, unknown> = {}) => ({
  id, happened_at: new Date('2026-11-12T05:00:00Z'), accommodation_name: 'Дом у вулкана',
  check_in: '2026-12-10', check_out: '2026-12-12', guests: 3,
  contact_name: 'Вера', contact_phone: '+79990000003', partner_name: 'Хозяин',
  taken_at: null, taken_via: null, taken_by_name: null, is_taken: false,
  ...patch,
});

const ids = (s: ManagerQueue[keyof Pick<ManagerQueue, 'answer_notice' | 'vehicle_decline' | 'stay_busy'>]) =>
  (s.state === 'ok' ? s.items.map((i) => i.id) : s.state);

describe('чтение очереди: три источника, три исхода у каждого', () => {
  it('отказ одного источника — «не прочитался», а не «никого нет»; остальные прочитаны', async () => {
    const db = fakeDb([
      [QUEUE_NOTICES_SQL, () => dbError('57014')],
      [QUEUE_VEHICLE_SQL, () => []],
      [QUEUE_STAY_SQL, () => [stayRow(STAY)]],
    ]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const q = await loadManagerQueue({ query: db.query });
    expect(q.answer_notice).toEqual({ state: 'failed' });
    expect(q.vehicle_decline).toEqual({ state: 'ok', items: [], more: false });
    expect(ids(q.stay_busy)).toEqual([STAY]);
    expect(q.since).toBe(MANAGER_QUEUE_SINCE);
    // Каждый источник спрошен с днём начала очереди и сроком, сколько виден взятый случай;
    // в лог — имя источника и SQLSTATE, без строк.
    expect(QUEUE_TAKEN_DAYS).toBe(7);
    for (const sql of [QUEUE_NOTICES_SQL, QUEUE_VEHICLE_SQL, QUEUE_STAY_SQL]) {
      expect(db.calls.find((c) => c.sql === sql)?.params).toEqual([MANAGER_QUEUE_SINCE, QUEUE_TAKEN_DAYS]);
    }
    expect(err.mock.calls.flat().join(' ')).toMatch(/недоставленные отказы.*57014/);
    expect(err.mock.calls.flat().join(' ')).not.toMatch(/Вера|79990000003/);
    err.mockRestore();
  });

  it('недоставленный отказ стоит в очереди, только пока вид заявки построен из него', async () => {
    const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map(lead);
    const db = fakeDb([
      [QUEUE_NOTICES_SQL, () => [
        noticeRow('101', A, { answer_id: '11' }),                                             // кнопка «Отказать», заявка закрыта этим отказом
        noticeRow('102', B, { answer_id: '12', answer: 'no_seats', decline_reason: null }),   // потом завели бронь
        noticeRow('103', C, { activity_id: '31', activity_action: 'seller_closed' }),         // «Отказ» с причиной на сайте
        noticeRow('104', D, { activity_id: '32', activity_action: 'seller_closed' }),         // заявку вернули в работу
        noticeRow('105', E, { answer_id: '13', answer: 'no_seats', decline_reason: null }),   // человек сменил дату: ответа на новую нет
        noticeRow('106', F, { answer_id: '14' }),                                             // заявки уже нет
      ]],
      [QUEUE_VEHICLE_SQL, () => []],
      [QUEUE_STAY_SQL, () => []],
      [REQUEST_STATUS_BY_LEADS_SQL, () => [
        st(A, { lead_status: 'lost', lead_answer_id: '11', lead_answer: 'decline', lead_decline_reason: 'seats' }),
        st(B, { lead_status: 'new', lead_answer_id: '12', lead_answer: 'no_seats', booking_status: 'confirmed' }),
        st(C, { lead_status: 'lost', lead_lost_reason: 'seats', lead_closed_id: '31' }),
        st(D, { lead_status: 'contacted', lead_lost_reason: null, lead_closed_id: null }),
        st(E, { lead_status: 'new', lead_answer_id: null, lead_answer: null }),
      ] as unknown as Rows],
    ]);
    const q = await loadManagerQueue({ query: db.query });
    expect(ids(q.answer_notice)).toEqual(['101', '103']);
    // Сверка — один запрос на список, по заявкам списка.
    expect(db.count(REQUEST_STATUS_BY_LEADS_SQL)).toBe(1);
    expect(db.calls.find((c) => c.sql === REQUEST_STATUS_BY_LEADS_SQL)?.params).toEqual([[A, B, C, D, E, F]]);
    const first = q.answer_notice.state === 'ok' ? q.answer_notice.items[0] : null;
    expect(first).toEqual({
      kind: 'answer_notice', id: '101', happened_at: '2026-11-12T03:10:00.000Z', partner_name: 'Оператор',
      contact_name: 'Анна', contact_phone: '+79990000001', take: null,
      lead_id: A, lead_status: 'lost', answer: 'decline', decline_reason: 'seats', manager_channel: 'max',
      tour_title: 'Мутновский', date: '2026-12-02', people: 2, takes: [],
    });
  });

  it('другие компании, ответившие «Беру», — именами в случае; пустое и не строка в список не идут', async () => {
    const [A, B] = [1, 2].map(lead);
    const db = fakeDb([
      [QUEUE_NOTICES_SQL, () => [
        noticeRow('101', A, { answer_id: '11', takes: ['Компания Б', '', null, 'Третья'] }),
        noticeRow('102', B, { answer_id: '12', takes: null }),
      ]],
      [QUEUE_VEHICLE_SQL, () => []],
      [QUEUE_STAY_SQL, () => []],
      [REQUEST_STATUS_BY_LEADS_SQL, () => [
        st(A, { lead_status: 'lost', lead_answer_id: '11', lead_answer: 'decline', lead_decline_reason: 'seats' }),
        st(B, { lead_status: 'lost', lead_answer_id: '12', lead_answer: 'decline', lead_decline_reason: 'seats' }),
      ] as unknown as Rows],
    ]);
    const q = await loadManagerQueue({ query: db.query });
    const items = q.answer_notice.state === 'ok' ? q.answer_notice.items : [];
    expect(items.map((i) => i.takes)).toEqual([['Компания Б', 'Третья'], []]);
  });

  it('тот же отказ, но ответ на другой номер: чужой ответ вид заявки не подтверждает', async () => {
    const A = lead(1);
    const db = fakeDb([
      [QUEUE_NOTICES_SQL, () => [noticeRow('101', A, { answer_id: '11' })]],
      [QUEUE_VEHICLE_SQL, () => []],
      [QUEUE_STAY_SQL, () => []],
      // Вид заявки построен из ответа 99 (другой адресат после передачи), а строка ссылается на 11.
      [REQUEST_STATUS_BY_LEADS_SQL, () => [st(A, { lead_status: 'lost', lead_answer_id: '99', lead_answer: 'decline', lead_decline_reason: 'seats' })] as unknown as Rows],
    ]);
    expect(ids((await loadManagerQueue({ query: db.query })).answer_notice)).toEqual([]);
  });

  it('«Не могу» перевозчика и прокатчика: в очереди, пока заявку не взяли в работу', async () => {
    const [G, H, I, J] = [7, 8, 9, 10].map(lead);
    const db = fakeDb([
      [QUEUE_NOTICES_SQL, () => []],
      [QUEUE_VEHICLE_SQL, () => [
        vehicleRow('51', G),                                                                       // перевозчик: заявка закрыта его ответом
        vehicleRow('52', H, { vehicle_kind: 'car_rental', vehicle_title: 'УАЗ Патриот', lead_status: 'new', notice_state: 'undelivered' }),
        vehicleRow('53', I),                                                                       // менеджер взял заявку в работу
        vehicleRow('54', J, { vehicle_kind: 'car_rental', notice_state: 'что-то новое' }),         // прокат: заявку довели до сделки
      ]],
      [QUEUE_STAY_SQL, () => []],
      [REQUEST_STATUS_BY_LEADS_SQL, () => [
        st(G, { tool_name: 'request_charter', lead_status: 'lost', lead_partner_answer: 'decline', lead_partner_answer_id: '51' }),
        st(H, { tool_name: 'create_car_rental_request', lead_status: 'new', lead_partner_answer: 'decline', lead_partner_answer_id: '52' }),
        st(I, { tool_name: 'request_charter', lead_status: 'contacted', lead_partner_answer: 'decline', lead_partner_answer_id: '53' }),
        st(J, { tool_name: 'create_car_rental_request', lead_status: 'converted', lead_partner_answer: 'decline', lead_partner_answer_id: '54' }),
      ] as unknown as Rows],
    ]);
    const q = await loadManagerQueue({ query: db.query });
    expect(ids(q.vehicle_decline)).toEqual(['51', '52']);
    const [charter, rental] = q.vehicle_decline.state === 'ok' ? q.vehicle_decline.items : [];
    expect(charter).toMatchObject({ kind: 'vehicle_decline', vehicle_kind: 'charter', notice_state: 'delivered', lead_id: G, date_from: '2026-12-05', date_to: '2026-12-06' });
    expect(rental).toMatchObject({ vehicle_kind: 'car_rental', vehicle_title: 'УАЗ Патриот', notice_state: 'undelivered' });
  });

  it('сверка с видом заявки не удалась — источник «не прочитался», а не список без сверки', async () => {
    const db = fakeDb([
      [QUEUE_NOTICES_SQL, () => [noticeRow('101', lead(1), { answer_id: '11' })]],
      [QUEUE_VEHICLE_SQL, () => [vehicleRow('51', lead(7))]],
      [QUEUE_STAY_SQL, () => [stayRow(STAY)]],
      [REQUEST_STATUS_BY_LEADS_SQL, () => dbError('08006')],
    ]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const q = await loadManagerQueue({ query: db.query });
    expect(q.answer_notice).toEqual({ state: 'failed' });
    expect(q.vehicle_decline).toEqual({ state: 'failed' });
    // У жилья сверки нет: ответ хозяина один и не меняется.
    expect(ids(q.stay_busy)).toEqual([STAY]);
    err.mockRestore();
  });

  it('жильё с видом заявки не сверяется; пустые списки сверку не зовут', async () => {
    const db = fakeDb([
      [QUEUE_NOTICES_SQL, () => []],
      [QUEUE_VEHICLE_SQL, () => []],
      [QUEUE_STAY_SQL, () => [stayRow(STAY, { is_taken: true, taken_at: new Date('2026-11-12T06:00:00Z'), taken_via: 'site', taken_by_name: 'Ирина' })]],
    ]);
    const q = await loadManagerQueue({ query: db.query });
    expect(db.count(REQUEST_STATUS_BY_LEADS_SQL)).toBe(0);
    expect(q.stay_busy).toEqual({
      state: 'ok', more: false,
      items: [{
        kind: 'stay_busy', id: STAY, stay_request_id: STAY, happened_at: '2026-11-12T05:00:00.000Z', partner_name: 'Хозяин',
        contact_name: 'Вера', contact_phone: '+79990000003', accommodation_name: 'Дом у вулкана',
        check_in: '2026-12-10', check_out: '2026-12-12', guests: 3,
        take: { at: '2026-11-12T06:00:00.000Z', via: 'site', by: 'Ирина' },
      }],
    });
  });

  it('строк больше предела — разобраны последние, и это сказано', async () => {
    const many = Array.from({ length: QUEUE_SOURCE_LIMIT + 1 }, (_, i) => stayRow(`33333333-3333-4333-8333-${String(i).padStart(12, '0')}`));
    const db = fakeDb([[QUEUE_NOTICES_SQL, () => []], [QUEUE_VEHICLE_SQL, () => []], [QUEUE_STAY_SQL, () => many]]);
    const q = await loadManagerQueue({ query: db.query });
    expect(q.stay_busy.state === 'ok' && q.stay_busy.items).toHaveLength(QUEUE_SOURCE_LIMIT);
    expect(q.stay_busy.state === 'ok' && q.stay_busy.more).toBe(true);
  });

  it('чужая форма полей заявки — «не записано», а не выдумка', async () => {
    const A = lead(1);
    const db = fakeDb([
      [QUEUE_NOTICES_SQL, () => [noticeRow('101', A, {
        answer_id: '11', req_date: 'в июле', people: 'много', contact_name: '', contact_phone: null, partner_name: null, route_title: null,
      })]],
      [QUEUE_VEHICLE_SQL, () => []],
      [QUEUE_STAY_SQL, () => []],
      [REQUEST_STATUS_BY_LEADS_SQL, () => [st(A, { lead_status: 'lost', lead_answer_id: '11', lead_answer: 'decline' })] as unknown as Rows],
    ]);
    const q = await loadManagerQueue({ query: db.query });
    expect(q.answer_notice.state === 'ok' && q.answer_notice.items[0]).toMatchObject({
      date: null, people: null, contact_name: null, contact_phone: null, partner_name: null, tour_title: null,
    });
  });
});

describe('«Взял»: только на случай, который стоит в очереди, и один раз', () => {
  const HOLDS = (id: string, leadId: string): Array<[string, Handler]> => [
    [QUEUE_SUBJECT_SQL.answer_notice, () => [{ lead_id: leadId, answer_id: id, activity_id: null, activity_action: null }]],
    [REQUEST_STATUS_BY_LEADS_SQL, () => [st(leadId, { lead_status: 'lost', lead_answer_id: id, lead_answer: 'decline' })] as unknown as Rows],
  ];

  it('номер не той формы — случая нет, и в базу не ходили', async () => {
    const db = fakeDb([]);
    for (const [kind, id] of [['answer_notice', 'abc'], ['vehicle_decline', STAY], ['stay_busy', '12'], ['answer_notice', "1'; DROP"]] as const) {
      expect(await takeQueueItem({ kind, id, userId: ADMIN, via: 'site' }, { query: db.query })).toEqual({ kind: 'not_in_queue' });
      expect(await releaseQueueItem({ kind, id }, { query: db.query })).toEqual({ kind: 'not_taken' });
    }
    expect(db.calls).toHaveLength(0);
    expect(isQueueSubjectId('answer_notice', '101')).toBe(true);
    expect(isQueueSubjectId('stay_busy', STAY)).toBe(true);
    expect([...QUEUE_KINDS]).toEqual(['answer_notice', 'vehicle_decline', 'stay_busy']);
  });

  it('случай стоит в очереди — отметка записана: кто взял, откуда и с какого дня ведётся очередь', async () => {
    const A = lead(1);
    const take = queueTakeSql('answer_notice');
    const db = fakeDb([...HOLDS('11', A), [take, () => [{ taken_at: new Date('2026-11-12T07:00:00Z') }]]]);
    expect(await takeQueueItem({ kind: 'answer_notice', id: '101', userId: ADMIN, via: 'site' }, { query: db.query }))
      .toEqual({ kind: 'taken', at: '2026-11-12T07:00:00.000Z' });
    expect(db.calls.find((c) => c.sql === QUEUE_SUBJECT_SQL.answer_notice)?.params).toEqual(['101', MANAGER_QUEUE_SINCE]);
    expect(db.calls.find((c) => c.sql === take)?.params).toEqual(['answer_notice', '101', ADMIN, 'site', MANAGER_QUEUE_SINCE]);
  });

  it('случая в очереди уже нет (сообщение дошло, номер чужой) — отметки нет', async () => {
    const take = queueTakeSql('answer_notice');
    const db = fakeDb([[QUEUE_SUBJECT_SQL.answer_notice, () => []], [take, () => [{ taken_at: new Date() }]]]);
    expect(await takeQueueItem({ kind: 'answer_notice', id: '101', userId: ADMIN, via: 'site' }, { query: db.query }))
      .toEqual({ kind: 'not_in_queue' });
    expect(db.count(take)).toBe(0);
  });

  it('заявка переросла отказ (бронь) — отметки нет: звонок с устаревшим отказом был бы неправдой', async () => {
    const A = lead(1);
    const take = queueTakeSql('answer_notice');
    const db = fakeDb([
      [QUEUE_SUBJECT_SQL.answer_notice, () => [{ lead_id: A, answer_id: '11', activity_id: null, activity_action: null }]],
      [REQUEST_STATUS_BY_LEADS_SQL, () => [st(A, { lead_status: 'lost', lead_answer_id: '11', lead_answer: 'decline', booking_status: 'pending' })] as unknown as Rows],
      [take, () => [{ taken_at: new Date() }]],
    ]);
    expect(await takeQueueItem({ kind: 'answer_notice', id: '101', userId: ADMIN, via: 'site' }, { query: db.query }))
      .toEqual({ kind: 'not_in_queue' });
    expect(db.count(take)).toBe(0);
  });

  it('«Не могу» перевозчика сверяется по самой записи журнала', async () => {
    const G = lead(7);
    const take = queueTakeSql('vehicle_decline');
    const subject: [string, Handler] = [QUEUE_SUBJECT_SQL.vehicle_decline, () => [{ lead_id: G, id: '51' }]];
    const holds = fakeDb([
      subject,
      [REQUEST_STATUS_BY_LEADS_SQL, () => [st(G, { tool_name: 'request_charter', lead_status: 'lost', lead_partner_answer: 'decline', lead_partner_answer_id: '51' })] as unknown as Rows],
      [take, () => [{ taken_at: new Date('2026-11-12T07:00:00Z') }]],
    ]);
    expect((await takeQueueItem({ kind: 'vehicle_decline', id: '51', userId: ADMIN, via: 'site' }, { query: holds.query })).kind).toBe('taken');
    const moved = fakeDb([
      subject,
      [REQUEST_STATUS_BY_LEADS_SQL, () => [st(G, { tool_name: 'request_charter', lead_status: 'contacted', lead_partner_answer: 'decline', lead_partner_answer_id: '51' })] as unknown as Rows],
      [take, () => [{ taken_at: new Date() }]],
    ]);
    expect(await takeQueueItem({ kind: 'vehicle_decline', id: '51', userId: ADMIN, via: 'site' }, { query: moved.query })).toEqual({ kind: 'not_in_queue' });
    expect(moved.count(take)).toBe(0);
  });

  it('уже взят — говорит, кем и когда, и свою отметку отличает от чужой', async () => {
    const A = lead(1);
    const take = queueTakeSql('answer_notice');
    for (const mine of [true, false]) {
      const db = fakeDb([
        ...HOLDS('11', A),
        [take, () => []],
        [QUEUE_TAKE_READ_SQL, () => [{ taken_at: new Date('2026-11-12T06:30:00Z'), via: 'site', by_name: 'Ирина', mine }]],
      ]);
      expect(await takeQueueItem({ kind: 'answer_notice', id: '101', userId: ADMIN, via: 'site' }, { query: db.query }))
        .toEqual({ kind: 'already', at: '2026-11-12T06:30:00.000Z', by: 'Ирина', mine });
      expect(db.calls.find((c) => c.sql === QUEUE_TAKE_READ_SQL)?.params).toEqual(['answer_notice', '101', ADMIN]);
    }
  });

  it('между сверкой и записью случай вышел из очереди — отметки нет и «уже взят» не сказано', async () => {
    const A = lead(1);
    const db = fakeDb([...HOLDS('11', A), [queueTakeSql('answer_notice'), () => []], [QUEUE_TAKE_READ_SQL, () => []]]);
    expect(await takeQueueItem({ kind: 'answer_notice', id: '101', userId: ADMIN, via: 'site' }, { query: db.query }))
      .toEqual({ kind: 'not_in_queue' });
  });

  it('жильё: сверки с видом заявки нет — только условие в самой записи', async () => {
    const take = queueTakeSql('stay_busy');
    const db = fakeDb([[take, () => [{ taken_at: new Date('2026-11-12T07:00:00Z') }]]]);
    expect((await takeQueueItem({ kind: 'stay_busy', id: STAY, userId: ADMIN, via: 'max' }, { query: db.query })).kind).toBe('taken');
    expect(db.calls.map((c) => c.sql)).toEqual([take]);
    expect(db.calls[0]!.params).toEqual(['stay_busy', STAY, ADMIN, 'max', MANAGER_QUEUE_SINCE]);
  });

  it('отказ базы — «не записано», а не «взял» и не «случая нет»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const A = lead(1);
    const onWrite = fakeDb([...HOLDS('11', A), [queueTakeSql('answer_notice'), () => dbError('40001')]]);
    expect(await takeQueueItem({ kind: 'answer_notice', id: '101', userId: ADMIN, via: 'site' }, { query: onWrite.query })).toEqual({ kind: 'failed' });
    const onCheck = fakeDb([[QUEUE_SUBJECT_SQL.answer_notice, () => dbError('08006')]]);
    expect(await takeQueueItem({ kind: 'answer_notice', id: '101', userId: ADMIN, via: 'site' }, { query: onCheck.query })).toEqual({ kind: 'failed' });
    const onRelease = fakeDb([[QUEUE_RELEASE_SQL, () => dbError('08006')]]);
    expect(await releaseQueueItem({ kind: 'answer_notice', id: '101' }, { query: onRelease.query })).toEqual({ kind: 'failed' });
    err.mockRestore();
  });

  it('«Вернуть в очередь»: отметка снята либо её уже не было', async () => {
    const was = fakeDb([[QUEUE_RELEASE_SQL, () => [{ taken_at: new Date() }]]]);
    expect(await releaseQueueItem({ kind: 'stay_busy', id: STAY }, { query: was.query })).toEqual({ kind: 'released' });
    expect(was.calls[0]!.params).toEqual(['stay_busy', STAY]);
    const none = fakeDb([[QUEUE_RELEASE_SQL, () => []]]);
    expect(await releaseQueueItem({ kind: 'stay_busy', id: STAY }, { query: none.query })).toEqual({ kind: 'not_taken' });
  });
});

// ── Слова ────────────────────────────────────────────────────────────────────

const NOTICE: NoticeItem = {
  kind: 'answer_notice', id: '101', happened_at: '2026-11-12T03:10:00.000Z', partner_name: 'Оператор',
  contact_name: 'Анна', contact_phone: '+79990000001', take: null,
  lead_id: lead(1), lead_status: 'lost', answer: 'decline', decline_reason: 'weather', manager_channel: 'max',
  tour_title: 'Мутновский', date: '2026-12-02', people: 2, takes: [],
};
const VEHICLE: VehicleItem = {
  kind: 'vehicle_decline', id: '51', happened_at: '2026-11-12T04:00:00.000Z', partner_name: 'Перевозчик',
  contact_name: 'Борис', contact_phone: '+79990000002', take: { at: '2026-11-12T09:05:00.000Z', via: 'site', by: 'Ирина' },
  lead_id: lead(7), lead_status: 'lost', vehicle_kind: 'charter', vehicle_title: 'Елизово — Мутновский',
  date_from: '2026-12-05', date_to: '2026-12-06', notice_state: 'undelivered',
};
const STAY_ITEM: StayItem = {
  kind: 'stay_busy', id: STAY, stay_request_id: STAY, happened_at: '2026-11-12T05:00:00.000Z', partner_name: 'Хозяин',
  contact_name: 'Вера', contact_phone: null, take: null,
  accommodation_name: 'Дом у вулкана', check_in: '2026-12-10', check_out: '2026-12-12', guests: 3,
};

describe('слова очереди: только записанное', () => {
  it('что за заявка и что ответил партнёр', () => {
    expect(queueSubjectLine(NOTICE)).toBe('Тур «Мутновский», 02.12.2026, 2 чел.');
    expect(queueStateLines(NOTICE)).toEqual([
      '«Оператор»: отказ — погода, безопасность.',
      'Сообщение об этом до клиента не дошло.',
      'Письмо с телефоном ушло в рабочий чат MAX.',
    ]);
    expect(queueStateLines({ ...NOTICE, answer: 'no_seats', decline_reason: null, partner_name: null, manager_channel: null })).toEqual([
      'Оператор: мест на эту дату нет.',
      'Сообщение об этом до клиента не дошло.',
      'Письмо менеджеру ещё не отправлялось.',
    ]);
    expect(queueStateLines({ ...NOTICE, manager_channel: 'telegram-stub' })[2]).toBe('В MAX письмо не ушло; в Telegram — заглушка без телефона.');
    expect(queueStateLines({ ...NOTICE, manager_channel: 'none' })[2]).toBe('Письмо менеджеру пока не дошло — отправка повторяется.');
    // Другие компании ответили «Беру» — тому, кто звонит: чьё это слово и что это не бронь.
    expect(queueStateLines({ ...NOTICE, takes: ['Компания Б'] })[3])
      .toBe('На вопрос Ведара «возьмёте на эту дату?» ответили «Беру»: «Компания Б». Это слово компании, не бронь — заявку клиент оставляет сам.');
    expect(queueStateLines({ ...NOTICE, takes: ['Компания Б', 'Третья'] })[3])
      .toBe('На вопрос Ведара «возьмёте на эту дату?» ответили «Беру»: «Компания Б», «Третья». Это слово компаний, не бронь — заявку клиент оставляет сам.');
    // Ответ старой сборки сервера поля не несёт: строки нет, экран не падает.
    expect(queueStateLines({ ...NOTICE, takes: undefined as unknown as string[] })).toHaveLength(3);

    expect(queueSubjectLine(VEHICLE)).toBe('Машина под заказ: Елизово — Мутновский, с 05.12.2026 по 06.12.2026');
    expect(queueStateLines(VEHICLE)).toEqual(['Перевозчик «Перевозчик» ответил «Не могу».', 'Сообщение об отказе до заказчика не дошло — позвонить.']);
    expect(queueStateLines({ ...VEHICLE, vehicle_kind: 'car_rental', notice_state: 'delivered' })).toEqual([
      'Прокатчик «Перевозчик» ответил «Не могу».', 'Заказчику об отказе сообщено.',
    ]);
    // О чём записи нет, того строка не утверждает.
    expect(queueStateLines({ ...VEHICLE, partner_name: null, notice_state: null })).toEqual([
      'Перевозчик ответил «Не могу».', 'Сообщения заказчику по этому ответу нет.',
    ]);
    expect(queueSubjectLine({ ...VEHICLE, vehicle_kind: 'car_rental', vehicle_title: null, date_to: '2026-12-05' })).toBe('Прокат, 05.12.2026');

    expect(queueSubjectLine(STAY_ITEM)).toBe('Жильё «Дом у вулкана», с 10.12.2026 по 12.12.2026, гостей: 3');
    expect(queueStateLines(STAY_ITEM)).toEqual(['Хозяин «Хозяин» ответил «занято».']);
  });

  it('номер заявки — тот, что стоит в сообщении менеджеру; отметка называет, кто и когда взял, по Камчатке', () => {
    expect(queueRequestId(NOTICE)).toBe(lead(1));
    expect(queueRequestId(STAY_ITEM)).toBe(STAY);
    expect(kamchatkaStamp(new Date('2026-11-12T09:05:00Z'))).toBe('12.11, 21:05');
    expect(kamchatkaStamp(new Date('2026-12-31T13:30:00Z'))).toBe('01.01, 01:30');
    expect(takeLine({ at: '2026-11-12T09:05:00.000Z', via: 'site', by: 'Ирина' })).toBe('Взял: Ирина, 12.11, 21:05');
    expect(takeLine({ at: '2026-11-12T09:05:00.000Z', via: 'max', by: null })).toBe('Взял: администратор (имя не записано), 12.11, 21:05, в MAX');
    expect(ruDate('2026-12-02')).toBe('02.12.2026');
    expect(ruDate(null)).toBeNull();
  });

  it('у каждого рода — заголовок, что делать и слова пустого списка', () => {
    for (const kind of QUEUE_KINDS) {
      const w = QUEUE_SECTION[kind];
      expect(w.title.length, kind).toBeGreaterThan(5);
      expect(w.lead.length, kind).toBeGreaterThan(20);
      expect(w.empty, kind).toMatch(/нет\.$/);
    }
  });

  it('ссылка на очередь добавляется только к сообщению о случае, который в неё встал', () => {
    expect(MANAGER_QUEUE_PATH).toBe('/hub/admin/queue');
    expect(managerQueueUrl().endsWith('/hub/admin/queue')).toBe(true);
    expect(withQueueLine('Перевозчик ответил «беру».', false)).toBe('Перевозчик ответил «беру».');
    const queued = withQueueLine('Перевозчик ответил «не могу».', true);
    expect(queued.split('\n')).toEqual([
      'Перевозчик ответил «не могу».',
      `В очереди менеджера — там же отметка «Взял»: ${managerQueueUrl()}`,
    ]);
  });
});

// ── Экран ────────────────────────────────────────────────────────────────────

type Sent = { url: string; method: string; body: unknown };

function stubApi(queues: ManagerQueue[], post: (body: { kind: string; id: string; action: string }) => { status: number; json: unknown }) {
  const sent: Sent[] = [];
  let gets = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;
    sent.push({ url, method, body });
    if (method === 'GET') {
      const data = queues[Math.min(gets, queues.length - 1)];
      gets++;
      return { ok: true, status: 200, json: async () => ({ success: true, data }) };
    }
    const r = post(body);
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  }));
  return { sent, gets: () => gets };
}

const queueOf = (patch: Partial<ManagerQueue> = {}): ManagerQueue => ({
  since: '2026-11-12',
  answer_notice: { state: 'ok', items: [], more: false },
  vehicle_decline: { state: 'ok', items: [], more: false },
  stay_busy: { state: 'ok', items: [], more: false },
  ...patch,
});

/** Свой кэш на каждый рендер: список одной проверки не протекает в другую. */
const renderQueue = () => render(
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    <ManagerQueueClient />
  </SWRConfig>,
);

describe('экран очереди', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('ждущий случай: что случилось, кому звонить, номер заявки; сбой источника назван сбоем, пусто — пустым', async () => {
    stubApi([queueOf({
      answer_notice: { state: 'ok', items: [NOTICE], more: false },
      vehicle_decline: { state: 'failed' },
    })], () => ({ status: 200, json: { success: true, outcome: 'taken' } }));
    renderQueue();

    const notices = await screen.findByRole('region', { name: /Отказ не дошёл до клиента — ждут: 1/ });
    const card = within(notices).getByTestId('queue-answer_notice-101');
    expect(card.textContent).toContain('Тур «Мутновский», 02.12.2026, 2 чел.');
    expect(card.textContent).toContain('«Оператор»: отказ — погода, безопасность.');
    expect(card.textContent).toContain('Сообщение об этом до клиента не дошло.');
    expect(card.textContent).toContain('Анна');
    expect(within(card).getByRole('link', { name: /\+79990000001/ }).getAttribute('href')).toBe('tel:+79990000001');
    expect(card.textContent).toContain(`Заявка ${lead(1)}`);
    expect(card.textContent).toContain('12.11, 15:10 по Камчатке');
    expect(within(card).getByRole('button', { name: 'Взял' })).toBeTruthy();

    const vehicles = screen.getByRole('region', { name: 'Перевозчик или прокатчик не может' });
    expect(within(vehicles).getByRole('alert').textContent).toMatch(/Не смогли прочитать эту часть очереди — это сбой, а не «никого нет»/);
    expect(within(vehicles).queryByText('Отказов перевозчиков и прокатчиков нет.')).toBeNull();

    const stays = screen.getByRole('region', { name: /Жильё занято — ждут: 0/ });
    expect(within(stays).getByText('Ответов «занято» нет.')).toBeTruthy();
    expect(screen.getByText(/Очередь ведётся с 12\.11\.2026/)).toBeTruthy();
  });

  it('другая компания ответила «Беру» — в карточке случая названа: кто, и что это не бронь', async () => {
    stubApi([queueOf({
      answer_notice: { state: 'ok', items: [{ ...NOTICE, takes: ['Компания Б'] }], more: false },
    })], () => ({ status: 200, json: { success: true, outcome: 'taken' } }));
    renderQueue();
    const card = await screen.findByTestId('queue-answer_notice-101');
    expect(card.textContent).toContain('ответили «Беру»: «Компания Б». Это слово компании, не бронь — заявку клиент оставляет сам.');
  });

  it('«Взял» уходит запросом с родом и номером случая; после ответа список перечитан и отметка видна', async () => {
    const taken: NoticeItem = { ...NOTICE, take: { at: '2026-11-12T09:05:00.000Z', via: 'site', by: 'Ирина' } };
    const api = stubApi(
      [queueOf({ answer_notice: { state: 'ok', items: [NOTICE], more: false } }), queueOf({ answer_notice: { state: 'ok', items: [taken], more: false } })],
      () => ({ status: 200, json: { success: true, outcome: 'taken' } }),
    );
    renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: 'Взял' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Отмечено: взяли вы.'));
    const posts = api.sent.filter((s) => s.method === 'POST');
    expect(posts).toEqual([{ url: '/api/admin/manager-queue', method: 'POST', body: { kind: 'answer_notice', id: '101', action: 'take' } }]);
    await waitFor(() => expect(api.gets()).toBe(2));
    const region = await screen.findByRole('region', { name: /Отказ не дошёл до клиента — ждут: 0/ });
    expect(within(region).getByText('Взято за последние 7 дней: 1')).toBeTruthy();
    expect(within(region).getByText('Взял: Ирина, 12.11, 21:05')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Взял' })).toBeNull();

    // «Вернуть в очередь» — тем же адресом, действием release.
    fireEvent.click(within(region).getByRole('button', { name: 'Вернуть в очередь' }));
    await waitFor(() => expect(api.sent.filter((s) => s.method === 'POST')).toHaveLength(2));
    expect(api.sent.filter((s) => s.method === 'POST')[1]!.body).toEqual({ kind: 'answer_notice', id: '101', action: 'release' });
  });

  it('случая в очереди уже нет — слова двери показаны как ошибка, «взяли вы» не сказано', async () => {
    stubApi([queueOf({ stay_busy: { state: 'ok', items: [STAY_ITEM], more: false } })], () => ({
      status: 409, json: { success: false, outcome: 'not_in_queue', error: 'Этого случая в очереди уже нет: сообщение дошло или заявка изменилась. Обновите список.' },
    }));
    renderQueue();
    const card = await screen.findByTestId(`queue-stay_busy-${STAY}`);
    // Телефона нет — так и сказано, ссылки для звонка нет.
    expect(card.textContent).toContain('Телефон не записан');
    expect(within(card).queryByRole('link')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Взял' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Этого случая в очереди уже нет'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('уже взят другим — так и сказано', async () => {
    stubApi([queueOf({ stay_busy: { state: 'ok', items: [STAY_ITEM], more: false } })], () => ({
      status: 200, json: { success: true, outcome: 'already' },
    }));
    renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: 'Взял' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Этот случай уже взят — список обновлён.'));
  });

  it('очередь не загрузилась — сбой, а не три пустых списка', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ success: false }) })));
    renderQueue();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Очередь не загрузилась — это сбой, а не «никого нет»/);
    expect(screen.queryByText('Недоставленных отказов нет.')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('перечитать список после нажатия не удалось — прежний список не остаётся под видом свежего', async () => {
    let gets = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') !== 'GET') return { ok: true, status: 200, json: async () => ({ success: true, outcome: 'taken' }) };
      gets++;
      return gets === 1
        ? { ok: true, status: 200, json: async () => ({ success: true, data: queueOf({ stay_busy: { state: 'ok', items: [STAY_ITEM], more: false } }) }) }
        : { ok: false, status: 503, json: async () => ({ success: false }) };
    }));
    renderQueue();
    fireEvent.click(within(await screen.findByTestId(`queue-stay_busy-${STAY}`)).getByRole('button', { name: 'Взял' }));
    await waitFor(() => expect(screen.getByText(/Очередь не загрузилась — это сбой, а не «никого нет»/)).toBeTruthy());
    expect(screen.queryByTestId(`queue-stay_busy-${STAY}`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Взял' })).toBeNull();
  });

  it('разобраны не все строки источника — сказано над списком', async () => {
    stubApi([queueOf({ answer_notice: { state: 'ok', items: [NOTICE], more: true } })], () => ({ status: 200, json: { success: true } }));
    renderQueue();
    expect(await screen.findByText('Разобраны только последние случаи — более ранние в список не попали.')).toBeTruthy();
  });
});
