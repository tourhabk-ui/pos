/**
 * tests/unit/guide-own-manual-booking.test.ts
 *
 * Гид-продавец записывает бронь своего тура сам — по звонку или из заявки
 * (#3211, слово владельца 10.11). Правило — общее с ручной бронью оператора
 * (lib/bookings/manual-booking); дверь гида — POST /api/guide/own/bookings.
 *
 * Что держит — вызовом роута с подменённой базой:
 *  - тур только свой: запрос тура — с карточкой гида; чужой — 404, вставки нет;
 *  - бронь подтверждённая, без оплаты и без способа оплаты, «по звонку»;
 *    «оплачено» в теле запроса ничего не меняет;
 *  - из заявки: скоуп — только адресованная гиду (`operator_id = $2`, без
 *    ничейных); бронь помнит заявку, «Договорились» — той же транзакцией,
 *    событие в ленте от гида; чужая — 404, вставки нет;
 *  - клиент — в CRM; уведомления «новая бронь» гиду о его же записи нет;
 *  - неверные поля — 400 словами; нет карточки — 404; отказ базы — 503
 *    «не записана» и SQLSTATE в логе, без контактов туриста.
 * Транзакция на настоящем PostgreSQL — tests/integration/tourist-cabinet.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  tx: [] as unknown[][],
  partner: vi.fn(),
  role: vi.fn(),
  link: vi.fn(async () => undefined),
  event: vi.fn(async () => undefined),
  notify: vi.fn(async () => undefined),
}));

vi.mock('@/lib/database', () => ({
  query: (...a: unknown[]) => h.query(...a),
  transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...a: unknown[]) => { h.tx.push(a); return h.query(...a); } }),
}));
vi.mock('@/lib/auth/middleware', () => ({ requireRole: (...a: unknown[]) => h.role(...a) }));
vi.mock('@/lib/auth/guide-helpers', () => ({ getGuidePartnerId: (...a: unknown[]) => h.partner(...a) }));
vi.mock('@/lib/crm/contacts', () => ({ linkContactQuietly: (...a: unknown[]) => h.link(...(a as [])) }));
vi.mock('@/lib/crm/events', () => ({
  recordSourceEventQuietly: (...a: unknown[]) => h.event(...(a as [])),
  statusChangeTitle: (_k: string, from: string, to: string) => `${from} → ${to}`,
}));
vi.mock('@/lib/notifications/operator-booking', () => ({ notifyNewBooking: (...a: unknown[]) => h.notify(...(a as [])) }));

import { POST } from '@/app/api/guide/own/bookings/route';

const GUIDE = '66666666-6666-4666-8666-666666666666';
const GUIDE_USER = '77777777-7777-4777-8777-777777777777';
const LEAD = 'aaaaaaaa-1111-4222-8333-444444444444';
const TOURIST_PHONE = '+70000000099';

interface World { tour: boolean; lead: { id: string; status: string } | null; insertFails: Error | null }
let world: World;

function post(body: unknown): Promise<Response> {
  return POST(new NextRequest('http://x/api/guide/own/bookings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

const BASE = { operator_tour_id: 101, booking_date: '2027-07-26', participants: 2, tourist_name: 'Ольга', tourist_phone: TOURIST_PHONE };
const sqlCalls = (re: RegExp) => h.query.mock.calls.filter((c) => re.test(String(c[0])));
const insertOf = () => h.tx.find((c) => /INSERT INTO operator_bookings/.test(String(c[0])));

beforeEach(() => {
  h.query.mockReset();
  h.tx.length = 0;
  h.link.mockClear();
  h.event.mockClear();
  h.notify.mockClear();
  h.role.mockResolvedValue({ userId: GUIDE_USER, role: 'guide' });
  h.partner.mockResolvedValue(GUIDE);
  world = { tour: true, lead: { id: LEAD, status: 'new' }, insertFails: null };
  h.query.mockImplementation(async (sql: string) => {
    if (/FROM operator_tours\s+WHERE id = \$1 AND operator_id = \$2/.test(sql)) {
      return { rows: world.tour ? [{ id: '101', title: 'Толбачик', base_price: 10000, price_unit: 'per_person', multi_day_count: null, duration_hours: null }] : [] };
    }
    if (/FROM leads WHERE id = \$1::uuid/.test(sql)) return { rows: world.lead ? [world.lead] : [] };
    if (/INSERT INTO operator_bookings/.test(sql)) {
      if (world.insertFails) throw world.insertFails;
      return { rows: [{ id: 9001, booking_date: '2027-07-26', participants: 2, final_price: 20000, booking_status: 'confirmed' }] };
    }
    return { rows: [] };
  });
});

describe('POST /api/guide/own/bookings — бронь по звонку', () => {
  it('свой тур: бронь подтверждённая, без оплаты, «по звонку»; цена — по тарифу тура; клиент — в CRM; уведомления себе нет', async () => {
    const res = await post(BASE);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      success: true,
      data: { id: '9001', booking_date: '2027-07-26', participants: 2, final_price: 20000, booking_status: 'confirmed', lead_id: null },
    });
    // Тур спрошен с карточкой гида — чужой не найдётся.
    expect(sqlCalls(/FROM operator_tours\s+WHERE id = \$1 AND operator_id = \$2/)[0]?.[1]).toEqual([101n, GUIDE]);
    const insert = insertOf();
    const sql = String(insert?.[0]);
    const params = insert?.[1] as unknown[];
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
    const value = (col: string) => params[cols.indexOf(col)];
    expect(value('booking_status')).toBe('confirmed');
    expect(value('payment_status')).toBe('pending');
    expect(value('payment_method')).toBeNull();
    expect(value('created_via')).toBe('direct_contact');
    expect(value('final_price')).toBe(20000);
    expect(cols).not.toContain('lead_id');
    // Строка тура под замком до вставки; заявки нет — UPDATE leads нет.
    expect(String(h.tx[0]?.[0])).toMatch(/FROM operator_tours WHERE id = \$1 FOR SHARE/);
    expect(h.tx.some((c) => /UPDATE leads/.test(String(c[0])))).toBe(false);
    expect(h.link).toHaveBeenCalledWith('operator_booking', 9001);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.event).not.toHaveBeenCalled();
  });

  it('«оплачено» и способ оплаты в теле запроса ничего не меняют: оплаты здесь нет', async () => {
    await post({ ...BASE, payment_status: 'paid', payment_method: 'cash', booking_status: 'new' });
    const insert = insertOf();
    const sql = String(insert?.[0]);
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
    const params = insert?.[1] as unknown[];
    expect(params[cols.indexOf('payment_status')]).toBe('pending');
    expect(params[cols.indexOf('payment_method')]).toBeNull();
    expect(params[cols.indexOf('booking_status')]).toBe('confirmed');
  });

  it('своя цена брони — гиду можно: тур продаёт он', async () => {
    const res = await post({ ...BASE, final_price: 15000 });
    expect(res.status).toBe(201);
    const insert = insertOf();
    const sql = String(insert?.[0]);
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
    expect((insert?.[1] as unknown[])[cols.indexOf('final_price')]).toBe(15000);
  });

  it('чужой тур — 404 «не найден среди ваших», вставки нет', async () => {
    world.tour = false;
    const res = await post(BASE);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Тур не найден среди ваших');
    expect(insertOf()).toBeUndefined();
  });
});

describe('POST /api/guide/own/bookings — из заявки', () => {
  it('заявка гида: скоуп — только адресованные ему; бронь помнит заявку, «Договорились» той же транзакцией, событие от гида', async () => {
    const res = await post({ ...BASE, lead_id: LEAD });
    expect(res.status).toBe(201);
    expect((await res.json()).data.lead_id).toBe(LEAD);
    const [leadSql, leadParams] = sqlCalls(/FROM leads WHERE id = \$1::uuid/)[0] as [string, unknown[]];
    expect(leadSql).toMatch(/AND operator_id = \$2 LIMIT 1/);
    expect(leadSql).not.toMatch(/operator_id IS NULL/);
    expect(leadParams).toEqual([LEAD, GUIDE]);
    const insert = insertOf();
    expect(String(insert?.[0])).toMatch(/lead_id\)/);
    expect(insert?.[1]).toEqual(expect.arrayContaining([LEAD]));
    const update = h.tx.find((c) => /UPDATE leads/.test(String(c[0])));
    expect(String(update?.[0])).toMatch(/SET status = 'converted'/);
    expect(update?.[1]).toEqual([LEAD, GUIDE]);
    expect(h.tx.indexOf(insert!)).toBeLessThan(h.tx.indexOf(update!));
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'status_change', sourceKind: 'lead', sourceId: LEAD, actorKind: 'partner_user', actorUserId: GUIDE_USER,
      payload: expect.objectContaining({ from: 'new', to: 'converted', booking_id: '9001' }),
    }));
  });

  it('чужая или ничейная заявка — 404 «не найдена среди ваших», вставки нет', async () => {
    world.lead = null;
    const res = await post({ ...BASE, lead_id: LEAD });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Заявка не найдена среди ваших');
    expect(insertOf()).toBeUndefined();
  });
});

describe('POST /api/guide/own/bookings — отказы', () => {
  it.each([
    [{ ...BASE, booking_date: '26.07.2027' }, /Дата поездки/],
    [{ ...BASE, participants: 0 }, /Хотя бы один человек/],
    [{ ...BASE, tourist_email: 'не почта' }, /Почта не похожа/],
    [{ ...BASE, tourist_phone: '+7'.padEnd(25, '0') }, /Телефон длиннее 20/],
    [{ ...BASE, lead_id: 'не-номер' }, /Неверный номер заявки/],
  ])('неверное поле — 400 словами, база не тронута (%#)', async (body, msg) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(msg);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('пустая почта из формы — не ошибка', async () => {
    expect((await post({ ...BASE, tourist_email: '' })).status).toBe(201);
  });

  it('нет карточки гида — 404; не гид — ответ проверки роли', async () => {
    h.partner.mockResolvedValue(null);
    expect((await post(BASE)).status).toBe(404);
    h.role.mockResolvedValue(new Response(null, { status: 403 }));
    const { NextResponse } = await import('next/server');
    h.role.mockResolvedValue(NextResponse.json({ error: 'нет доступа' }, { status: 403 }));
    expect((await post(BASE)).status).toBe(403);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('база не ответила — 503 «не записана», в логе SQLSTATE, а не телефон туриста', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    world.insertFails = Object.assign(new Error(`duplicate ${TOURIST_PHONE}`), { code: '40P01' });
    const res = await post(BASE);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('Бронь не записана — попробуйте ещё раз');
    expect(err).toHaveBeenCalledWith('[guide/own/bookings] ручная бронь не записана:', 'sqlstate=40P01');
    expect(JSON.stringify(err.mock.calls)).not.toContain(TOURIST_PHONE);
    expect(h.link).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
