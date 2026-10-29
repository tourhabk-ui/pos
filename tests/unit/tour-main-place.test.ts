/**
 * Главное место тура правится в кабинете (аудит 15.10, TOUR-PLACE, миграция 1286).
 *
 * У туров, заведённых миграциями, route_id пуст, и связи «тур → место» не было
 * ни одной: «Туры сюда» на карточках мест и китайские конспекты мест давали
 * ноль. Кабинет теперь даёт выбрать главное место тура из справочника — и
 * роут правки принимает только живое место (существует, видимо, не слито),
 * пишет источник 'operator' и не трогает связь, если её не меняли: форма шлёт
 * поле при каждом сохранении, и связь «по координатам» не должна выдавать себя
 * за выбор оператора.
 *
 * Здесь — вызов PATCH с подставной базой: что уходит в SQL и какой ответ.
 * Что проверка места на самом деле отсекает скрытое, слитое и чужое — на
 * настоящем PostgreSQL (tests/integration/public-tour-gate.pg.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { clientQuery, getTourByIdMock, plainQuery } = vi.hoisted(() => ({ clientQuery: vi.fn(), getTourByIdMock: vi.fn(), plainQuery: vi.fn() }));

vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn(async () => ({ userId: 'user-op', role: 'operator' })),
  requireAdmin: vi.fn(async () => ({ userId: 'user-admin', role: 'admin' })),
}));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: vi.fn(async () => 'op-1') }));
vi.mock('@/lib/operators/team-access', () => ({ requireTeamPermission: vi.fn(async () => null) }));
vi.mock('@/lib/operators/team-money', () => ({ changesTourPrice: () => false }));
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: vi.fn() }));
vi.mock('@/lib/db/column-types', () => ({ getColumnTypes: vi.fn(async () => new Map()), valueForColumn: (v: unknown) => v }));
vi.mock('@/lib/database', () => ({
  transaction: async (fn: (c: { query: typeof clientQuery }) => unknown) => fn({ query: clientQuery }),
  query: plainQuery,
}));
vi.mock('@/lib/api/operator-tours', async (orig) => {
  const real = await orig<typeof import('@/lib/api/operator-tours')>();
  return { ...real, getTourById: getTourByIdMock, softDeleteTour: vi.fn() };
});

import { PATCH } from '@/app/api/hub/operator/tours/[id]/route';
import { POST as CREATE } from '@/app/api/hub/operator/tours/route';
import { PATCH as ADMIN_PATCH } from '@/app/api/admin/operator-tours/[id]/route';
import { UpdateTourSchema } from '@/lib/api/operator-tours';

const patch = (body: unknown) => PATCH(
  new NextRequest('https://vedarai.ru/api/hub/operator/tours/7', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: '7' }) },
);

/** Справочник мест подставной базы: id → живо ли место. */
let livePlaces: Set<string>;

beforeEach(() => {
  livePlaces = new Set(['vulkan-gorelyj']);
  clientQuery.mockReset();
  clientQuery.mockImplementation(async (sql: string, values: unknown[]) => {
    if (/FROM places/.test(sql)) {
      return { rows: livePlaces.has(String(values[0])) ? [{ id: values[0] }] : [] };
    }
    return { rows: [{ id: '7', title: 'Вулкан Горелый', updated_at: 'now' }] };
  });
  plainQuery.mockReset();
  plainQuery.mockImplementation(async (sql: string) => {
    if (/SELECT id, location_type, activity_type, main_place_id/.test(sql)) {
      return { rows: [{ id: '7', location_type: 'volcano', activity_type: 'trekking', main_place_id: null }] };
    }
    return { rows: [{ id: '7', title: 'Вулкан Горелый' }] };
  });
  getTourByIdMock.mockReset();
  getTourByIdMock.mockResolvedValue({ id: '7', operator_id: 'op-1', base_price: 15000, main_place_id: null, main_place_source: null });
});

const updateCall = () => clientQuery.mock.calls.find(([sql]) => /UPDATE operator_tours/.test(sql as string));

describe('PATCH тура: главное место', () => {
  it('живое место — пишется с источником operator; проверка места идёт до UPDATE', async () => {
    const res = await patch({ main_place_id: 'vulkan-gorelyj' });
    expect(res.status).toBe(200);
    const [checkSql, checkValues] = clientQuery.mock.calls[0];
    expect(checkSql).toMatch(/FROM places/);
    expect(checkValues).toEqual(['vulkan-gorelyj']);
    const [sql, values] = updateCall()!;
    const placeAt = (sql as string).match(/main_place_id = \$(\d+)::text/);
    const sourceAt = (sql as string).match(/main_place_source = \$(\d+)::text/);
    expect(placeAt && sourceAt).toBeTruthy();
    expect((values as unknown[])[Number(placeAt![1]) - 1]).toBe('vulkan-gorelyj');
    expect((values as unknown[])[Number(sourceAt![1]) - 1]).toBe('operator');
  });

  it('места нет, оно скрыто или слито — 400 словами, UPDATE не уходит', async () => {
    const res = await patch({ main_place_id: 'skrytoe-mesto' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Главное место не найдено/);
    expect(updateCall()).toBeUndefined();
  });

  it('null — связь снимается вместе с источником, место не проверяется', async () => {
    getTourByIdMock.mockResolvedValue({ id: '7', operator_id: 'op-1', main_place_id: 'vulkan-gorelyj', main_place_source: 'coords_equal' });
    const res = await patch({ main_place_id: null });
    expect(res.status).toBe(200);
    expect(clientQuery.mock.calls.some(([sql]) => /FROM places/.test(sql as string))).toBe(false);
    const [sql, values] = updateCall()!;
    const placeAt = (sql as string).match(/main_place_id = \$(\d+)::text/)!;
    const sourceAt = (sql as string).match(/main_place_source = \$(\d+)::text/)!;
    expect((values as unknown[])[Number(placeAt[1]) - 1]).toBeNull();
    expect((values as unknown[])[Number(sourceAt[1]) - 1]).toBeNull();
  });

  it('то же место, что сохранено, — связь не трогается: «по координатам» не становится выбором оператора', async () => {
    getTourByIdMock.mockResolvedValue({ id: '7', operator_id: 'op-1', main_place_id: 'vulkan-gorelyj', main_place_source: 'coords_equal' });
    // Место с тех пор скрыли — сохранить остальную форму это не мешает.
    livePlaces = new Set();
    const res = await patch({ title: 'Вулкан Горелый — восхождение', main_place_id: 'vulkan-gorelyj' });
    expect(res.status).toBe(200);
    const [sql] = updateCall()!;
    expect(sql).not.toMatch(/main_place/);
    expect(clientQuery.mock.calls.some(([s]) => /FROM places/.test(s as string))).toBe(false);
  });

  it('поле не прислано — связь не трогается', async () => {
    await patch({ title: 'Вулкан Горелый — восхождение' });
    expect(updateCall()![0]).not.toMatch(/main_place/);
  });

  it('чужой тур — 404, место не проверяется и UPDATE не уходит', async () => {
    getTourByIdMock.mockResolvedValue({ id: '7', operator_id: 'op-other', main_place_id: null });
    const res = await patch({ main_place_id: 'vulkan-gorelyj' });
    expect(res.status).toBe(404);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('схема: строка-id или null; число и пустая строка — отказ', () => {
    expect(UpdateTourSchema.safeParse({ main_place_id: 'vulkan-gorelyj' }).success).toBe(true);
    expect(UpdateTourSchema.safeParse({ main_place_id: null }).success).toBe(true);
    expect(UpdateTourSchema.safeParse({ main_place_id: 42 }).success).toBe(false);
    expect(UpdateTourSchema.safeParse({ main_place_id: '   ' }).success).toBe(false);
  });
});

const NEW_TOUR = {
  title: 'Вулкан Горелый — восхождение', location_type: 'volcano', activity_type: 'trekking',
  location_name: 'Вулкан Горелый', base_price: 15000, max_participants: 8,
};
const create = (body: unknown) => CREATE(
  new NextRequest('https://vedarai.ru/api/hub/operator/tours', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
);
const insertCall = () => clientQuery.mock.calls.find(([sql]) => /INSERT INTO operator_tours/.test(sql as string));

describe('создание тура: главное место сразу (1344, слово владельца 29.10)', () => {
  it('живое место — проверено в транзакции и записано с источником operator', async () => {
    clientQuery.mockImplementation(async (sql: string, values: unknown[]) => {
      if (/FROM places/.test(sql)) return { rows: livePlaces.has(String(values[0])) ? [{ id: values[0] }] : [] };
      return { rows: [{ id: '99', title: NEW_TOUR.title }] };
    });
    const res = await create({ ...NEW_TOUR, main_place_id: 'vulkan-gorelyj' });
    expect(res.status).toBe(201);
    expect(clientQuery.mock.calls[0][0]).toMatch(/FROM places[\s\S]*FOR SHARE/);
    const [sql, values] = insertCall()!;
    const cols = (sql as string).slice((sql as string).indexOf('(') + 1, (sql as string).indexOf(')')).split(',').map((c) => c.trim());
    expect(cols).toContain('main_place_id');
    expect((values as unknown[])[cols.indexOf('main_place_id')]).toBe('vulkan-gorelyj');
    expect(sql).toMatch(/CASE WHEN \$33::text IS NULL THEN NULL ELSE 'operator' END/);
  });

  it('скрытое место — 400 словами, тур не создан', async () => {
    const res = await create({ ...NEW_TOUR, main_place_id: 'skrytoe-mesto' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Главное место не найдено/);
    expect(insertCall()).toBeUndefined();
  });

  it('место не выбрано — тур создаётся без связи, место не проверяется', async () => {
    const res = await create(NEW_TOUR);
    expect(res.status).toBe(201);
    expect(clientQuery).not.toHaveBeenCalled();
    const [sql, values] = plainQuery.mock.calls.find(([q]) => /INSERT INTO operator_tours/.test(q as string))!;
    expect(sql).toMatch(/main_place_id/);
    expect((values as unknown[])[32]).toBeNull();
  });
});

describe('администратор ставит главное место — источник admin', () => {
  const adminPatch = (body: unknown) => ADMIN_PATCH(
    new NextRequest('https://vedarai.ru/api/admin/operator-tours/7', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    { params: { id: '7' } },
  );

  it('живое место — в транзакции, источник admin', async () => {
    const res = await adminPatch({ main_place_id: 'vulkan-gorelyj' });
    expect(res.status).toBe(200);
    expect(clientQuery.mock.calls[0][0]).toMatch(/FROM places/);
    const [sql, values] = updateCall()!;
    const sourceAt = (sql as string).match(/main_place_source = \$(\d+)::text/)!;
    expect((values as unknown[])[Number(sourceAt[1]) - 1]).toBe('admin');
  });

  it('скрытое место — 400, UPDATE не уходит', async () => {
    const res = await adminPatch({ main_place_id: 'skrytoe-mesto' });
    expect(res.status).toBe(400);
    expect(updateCall()).toBeUndefined();
  });
});

describe('вид тура из миграции не запирает правку (jeep_safari, snowmobile…)', () => {
  it('сохранённый jeep_safari и новое место — 200, место записано', async () => {
    getTourByIdMock.mockResolvedValue({ id: '7', operator_id: 'op-1', activity_type: 'jeep_safari', location_type: 'sightseeing', main_place_id: null });
    const res = await patch({ activity_type: 'jeep_safari', location_type: 'sightseeing', main_place_id: 'vulkan-gorelyj' });
    expect(res.status).toBe(200);
    const [sql, values] = updateCall()!;
    const placeAt = (sql as string).match(/main_place_id = \$(\d+)::text/)!;
    expect((values as unknown[])[Number(placeAt[1]) - 1]).toBe('vulkan-gorelyj');
  });

  it('смена trekking на jeep_safari — 400: новое значение только из списка формы', async () => {
    getTourByIdMock.mockResolvedValue({ id: '7', operator_id: 'op-1', activity_type: 'trekking', location_type: 'volcano', main_place_id: null });
    const res = await patch({ activity_type: 'jeep_safari' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Вид активности «jeep_safari» не из списка/);
    expect(updateCall()).toBeUndefined();
  });

  it('то же в админке: смена вида на незнакомый — 400', async () => {
    const res = await ADMIN_PATCH(
      new NextRequest('https://vedarai.ru/api/admin/operator-tours/7', { method: 'PATCH', body: JSON.stringify({ location_type: 'coast' }), headers: { 'content-type': 'application/json' } }),
      { params: { id: '7' } },
    );
    expect(res.status).toBe(400);
  });
});
