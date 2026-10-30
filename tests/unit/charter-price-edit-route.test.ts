/**
 * Двери прайса перевозчика (#2862 этап C): кабинет (requireCarrier) и
 * модерация (requireAdmin) — исполнением роутов на подставленном хранилище.
 *
 *  - без перевозчика и без администратора хранилище не зовётся;
 *  - черновик правки — только своей строки, пустой — 400; новая строка — по форме;
 *  - одобрение без полей из карточки не принимается; changed и duplicate — 409;
 *  - после решения партнёру уходит уведомление с причиной, отказ модерации
 *    проката — тоже;
 *  - PATCH машины: снять с линии, места «не записано» — null; чужая — 403.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requireAdmin = vi.fn();
const requireCarrier = vi.fn();
const store = {
  findOwnPriceRowById: vi.fn(), loadOwnDrafts: vi.fn(), loadOwnPriceRows: vi.fn(), saveNewPriceDraft: vi.fn(),
  savePricePatch: vi.fn(), listPendingPriceEdits: vi.fn(), decidePriceEdit: vi.fn(),
};
const notify = vi.fn(async () => undefined);
const updateVehicle = vi.fn();
const decideOfferEdit = vi.fn();

vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => requireAdmin(...a) }));
vi.mock('@/lib/transfers/carrier-auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/transfers/carrier-auth')>()),
  requireCarrier: (...a: unknown[]) => requireCarrier(...a),
}));
vi.mock('@/lib/transfers/price-edit-store', () => ({
  findOwnPriceRowById: (...a: unknown[]) => store.findOwnPriceRowById(...a),
  loadOwnDrafts: (...a: unknown[]) => store.loadOwnDrafts(...a),
  loadOwnPriceRows: (...a: unknown[]) => store.loadOwnPriceRows(...a),
  saveNewPriceDraft: (...a: unknown[]) => store.saveNewPriceDraft(...a),
  savePricePatch: (...a: unknown[]) => store.savePricePatch(...a),
  listPendingPriceEdits: (...a: unknown[]) => store.listPendingPriceEdits(...a),
  decidePriceEdit: (...a: unknown[]) => store.decidePriceEdit(...a),
}));
vi.mock('@/lib/notifications/partner-edit-notify', () => ({
  notifyPartnerEditDecisionQuietly: (...a: unknown[]) => notify(...a),
}));
vi.mock('@/lib/transfers/service', () => ({
  updateVehicle: (...a: unknown[]) => updateVehicle(...a),
  listVehicles: vi.fn(),
  addVehicle: vi.fn(),
}));
vi.mock('@/lib/rental/offer-edit-store', () => ({ decideOfferEdit: (...a: unknown[]) => decideOfferEdit(...a) }));

const PARTNER = '22222222-2222-4222-8222-222222222222';
const PRICE = '11111111-1111-4111-8111-111111111111';
const EDIT = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const VEHICLE = '55555555-5555-4555-8555-555555555555';

const row = {
  id: PRICE, vehicleKind: 'vahtovka', lineKind: 'destination', fromText: 'ПК', toText: 'Авачинский',
  priceRub: 65000, priceNote: null, conditions: null, validYear: 2026, isActive: true,
};
const seen = {
  priceRub: 70000, priceNote: null, conditions: null, isActive: null,
  vehicleKind: null, lineKind: null, fromText: null, toText: null, validYear: null,
};

beforeEach(() => {
  for (const f of Object.values(store)) f.mockReset();
  requireAdmin.mockReset();
  requireCarrier.mockReset();
  notify.mockClear();
  updateVehicle.mockReset();
  decideOfferEdit.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  requireAdmin.mockResolvedValue({ userId: ADMIN, role: 'admin' });
  requireCarrier.mockResolvedValue({ user: { userId: 'u' }, partnerId: PARTNER });
});

const json = (url: string, method: string, body?: unknown) => new NextRequest(url, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe('кабинет: /api/hub/carrier/prices', () => {
  it('без перевозчика хранилище не зовётся', async () => {
    requireCarrier.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));
    const { GET, POST } = await import('@/app/api/hub/carrier/prices/route');
    expect((await GET(json('https://vedarai.ru/api/hub/carrier/prices', 'GET'))).status).toBe(401);
    expect((await POST(json('https://vedarai.ru/api/hub/carrier/prices', 'POST', { priceId: PRICE, priceRub: 1 }))).status).toBe(401);
    expect(store.loadOwnPriceRows).not.toHaveBeenCalled();
    expect(store.savePricePatch).not.toHaveBeenCalled();
  });

  it('GET: каждый список может не прочитаться отдельно — null, не пустой', async () => {
    store.loadOwnPriceRows.mockResolvedValue({ outcome: 'ok', rows: [row] });
    store.loadOwnDrafts.mockResolvedValue({ outcome: 'db_error' });
    const { GET } = await import('@/app/api/hub/carrier/prices/route');
    const res = await GET(json('https://vedarai.ru/api/hub/carrier/prices', 'GET'));
    const body = await res.json() as { data: { rows: unknown[] | null; drafts: unknown[] | null } };
    expect(res.status).toBe(200);
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.drafts).toBeNull();
    expect(store.loadOwnPriceRows).toHaveBeenCalledWith(PARTNER);
  });

  it('POST правки: своя строка → черновик; чужая — 404; пустой — 400', async () => {
    store.findOwnPriceRowById.mockResolvedValue({ outcome: 'one', row });
    store.savePricePatch.mockResolvedValue({
      outcome: 'saved', saved: { id: EDIT, label: 'ПК — Авачинский (вахтовка)', live: row, draft: { priceRub: 70000, priceNote: null, conditions: null, isActive: null } },
    });
    const { POST } = await import('@/app/api/hub/carrier/prices/route');
    const ok = await POST(json('https://vedarai.ru/api/hub/carrier/prices', 'POST', { priceId: PRICE, priceRub: 70000 }));
    expect(ok.status).toBe(201);
    expect(store.findOwnPriceRowById).toHaveBeenCalledWith(PARTNER, PRICE);
    expect(store.savePricePatch.mock.calls[0]![0]).toMatchObject({ partnerId: PARTNER, patch: { priceRub: 70000, priceNote: null, conditions: null, isActive: null } });
    expect(((await ok.json()) as { message: string }).message).toContain('после одобрения');

    store.findOwnPriceRowById.mockResolvedValue({ outcome: 'missing' });
    expect((await POST(json('https://vedarai.ru/api/hub/carrier/prices', 'POST', { priceId: PRICE, isActive: false }))).status).toBe(404);

    store.findOwnPriceRowById.mockResolvedValue({ outcome: 'one', row });
    store.savePricePatch.mockResolvedValue({ outcome: 'empty' });
    expect((await POST(json('https://vedarai.ru/api/hub/carrier/prices', 'POST', { priceId: PRICE }))).status).toBe(400);

    // Ноль рублей — не цена: до хранилища не доходит.
    store.savePricePatch.mockClear();
    expect((await POST(json('https://vedarai.ru/api/hub/carrier/prices', 'POST', { priceId: PRICE, priceRub: 0 }))).status).toBe(400);
    expect(store.savePricePatch).not.toHaveBeenCalled();
  });

  it('POST новой строки: форма до хранилища и в хранилище; кривая — 400 словами', async () => {
    store.saveNewPriceDraft.mockResolvedValue({ outcome: 'saved', id: EDIT, label: 'ПК — Горелый (джип)' });
    const { POST } = await import('@/app/api/hub/carrier/prices/route');
    const ok = await POST(json('https://vedarai.ru/api/hub/carrier/prices', 'POST', {
      vehicleKind: 'jeep', lineKind: 'destination', fromText: 'ПК', toText: 'Горелый', priceRub: 45000, validYear: 2026,
    }));
    expect(ok.status).toBe(201);
    expect(store.saveNewPriceDraft.mock.calls[0]![0]).toEqual({
      partnerId: PARTNER,
      row: { vehicleKind: 'jeep', lineKind: 'destination', fromText: 'ПК', toText: 'Горелый', priceRub: 45000, priceNote: null, conditions: null, validYear: 2026 },
    });
    store.saveNewPriceDraft.mockResolvedValue({ outcome: 'bad_shape', reason: 'destination_needs_texts' });
    const bad = await POST(json('https://vedarai.ru/api/hub/carrier/prices', 'POST', { vehicleKind: 'jeep', lineKind: 'destination', priceRub: 45000 }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('«откуда» и «куда»');
    expect((await POST(json('https://vedarai.ru/api/hub/carrier/prices', 'POST', { vehicleKind: 'bus', lineKind: 'per_hour', priceRub: 1 }))).status).toBe(400);
  });
});

describe('кабинет: PATCH /api/hub/carrier/vehicles/[id]', () => {
  const params = { params: Promise.resolve({ id: VEHICLE }) };

  it('снять с линии — isActive false; пустое число мест — null; пустой patch — 400', async () => {
    updateVehicle.mockResolvedValue({ ok: true, value: { id: VEHICLE, is_active: false } });
    const { PATCH } = await import('@/app/api/hub/carrier/vehicles/[id]/route');
    const res = await PATCH(json(`https://vedarai.ru/api/hub/carrier/vehicles/${VEHICLE}`, 'PATCH', { is_active: false }), params);
    expect(res.status).toBe(200);
    expect(updateVehicle).toHaveBeenCalledWith({ partnerId: PARTNER, vehicleId: VEHICLE, patch: { isActive: false } });
    await PATCH(json(`https://vedarai.ru/api/hub/carrier/vehicles/${VEHICLE}`, 'PATCH', { seats: null, notes: '' }), params);
    expect(updateVehicle).toHaveBeenLastCalledWith({ partnerId: PARTNER, vehicleId: VEHICLE, patch: { seats: null, notes: null } });
    updateVehicle.mockClear();
    expect((await PATCH(json(`https://vedarai.ru/api/hub/carrier/vehicles/${VEHICLE}`, 'PATCH', {}), params)).status).toBe(400);
    expect(updateVehicle).not.toHaveBeenCalled();
  });

  it('чужая машина — 403, нет такой — 404, без перевозчика — отказ до сервиса', async () => {
    const { PATCH } = await import('@/app/api/hub/carrier/vehicles/[id]/route');
    updateVehicle.mockResolvedValue({ ok: false, code: 'not_your_vehicle', message: 'чужая' });
    expect((await PATCH(json(`https://vedarai.ru/api/hub/carrier/vehicles/${VEHICLE}`, 'PATCH', { is_active: true }), params)).status).toBe(403);
    updateVehicle.mockResolvedValue({ ok: false, code: 'vehicle_not_found', message: 'нет' });
    expect((await PATCH(json(`https://vedarai.ru/api/hub/carrier/vehicles/${VEHICLE}`, 'PATCH', { is_active: true }), params)).status).toBe(404);
    updateVehicle.mockClear();
    requireCarrier.mockResolvedValue(NextResponse.json({ success: false }, { status: 403 }));
    expect((await PATCH(json(`https://vedarai.ru/api/hub/carrier/vehicles/${VEHICLE}`, 'PATCH', { is_active: true }), params)).status).toBe(403);
    expect(updateVehicle).not.toHaveBeenCalled();
  });
});

describe('модерация: /api/admin/moderation/charter-price-edits', () => {
  const params = { params: Promise.resolve({ id: EDIT }) };
  const url = `https://vedarai.ru/api/admin/moderation/charter-price-edits/${EDIT}`;

  it('без администратора хранилище не зовётся', async () => {
    requireAdmin.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));
    const { POST } = await import('@/app/api/admin/moderation/charter-price-edits/[id]/route');
    const { GET } = await import('@/app/api/admin/moderation/charter-price-edits/route');
    expect((await POST(json(url, 'POST', { action: 'approve', seen }), params)).status).toBe(401);
    expect((await GET(json('https://vedarai.ru/api/admin/moderation/charter-price-edits', 'GET'))).status).toBe(401);
    expect(store.decidePriceEdit).not.toHaveBeenCalled();
    expect(store.listPendingPriceEdits).not.toHaveBeenCalled();
  });

  it('одобрение несёт то, что видел модератор, и шлёт партнёру решение; без полей — 400', async () => {
    store.decidePriceEdit.mockResolvedValue({ outcome: 'approved', partnerId: PARTNER, label: 'ПК — Авачинский (вахтовка)' });
    const { POST } = await import('@/app/api/admin/moderation/charter-price-edits/[id]/route');
    const res = await POST(json(url, 'POST', { action: 'approve', seen }), params);
    expect(res.status).toBe(200);
    expect(store.decidePriceEdit).toHaveBeenCalledWith({ id: EDIT, action: 'approve', reason: null, moderatedBy: ADMIN, seen });
    expect(notify).toHaveBeenCalledWith({ partnerId: PARTNER, subject: 'charter', label: 'ПК — Авачинский (вахтовка)', outcome: 'approved', reason: null });
    store.decidePriceEdit.mockClear();
    const bad = await POST(json(url, 'POST', { action: 'approve' }), params);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('Обновите страницу');
    expect(store.decidePriceEdit).not.toHaveBeenCalled();
  });

  it('changed и duplicate — 409 с кодом, партнёру ничего не уходит; отказ — с причиной', async () => {
    const { POST } = await import('@/app/api/admin/moderation/charter-price-edits/[id]/route');
    store.decidePriceEdit.mockResolvedValue({ outcome: 'changed' });
    const changed = await POST(json(url, 'POST', { action: 'approve', seen }), params);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'changed' });
    store.decidePriceEdit.mockResolvedValue({ outcome: 'duplicate', label: 'ПК — Горелый (джип)' });
    const dup = await POST(json(url, 'POST', { action: 'approve', seen }), params);
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string; code: string }).code).toBe('duplicate');
    expect(notify).not.toHaveBeenCalled();

    store.decidePriceEdit.mockResolvedValue({ outcome: 'rejected', partnerId: PARTNER, label: 'ПК — Авачинский (вахтовка)' });
    const rej = await POST(json(url, 'POST', { action: 'reject', reason: 'не та цифра' }), params);
    expect(rej.status).toBe(200);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'rejected', reason: 'не та цифра' }));
    expect((await POST(json(url, 'POST', { action: 'reject', reason: 'нет' }), params)).status).toBe(400);
  });

  it('GET: очередь без телефона; отказ базы — 503', async () => {
    store.listPendingPriceEdits.mockResolvedValueOnce({ outcome: 'ok', edits: [{ id: EDIT, partnerName: 'Шатун', draft: seen, live: row, createdAt: 'x' }] });
    const { GET } = await import('@/app/api/admin/moderation/charter-price-edits/route');
    const ok = await GET(json('https://vedarai.ru/api/admin/moderation/charter-price-edits', 'GET'));
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await ok.json())).not.toMatch(/phone|email|\+7/i);
    store.listPendingPriceEdits.mockResolvedValueOnce({ outcome: 'db_error' });
    const bad = await GET(json('https://vedarai.ru/api/admin/moderation/charter-price-edits', 'GET'));
    expect(bad.status).toBe(503);
    expect(((await bad.json()) as { data?: unknown }).data).toBeUndefined();
  });

  it('решение по правке проката тоже доходит до прокатчика (та же дверь, другой предмет)', async () => {
    decideOfferEdit.mockResolvedValue({ outcome: 'rejected', title: 'Suzuki Jimny', partnerId: PARTNER });
    const { POST } = await import('@/app/api/admin/moderation/rental-edits/[id]/route');
    const res = await POST(json(`https://vedarai.ru/api/admin/moderation/rental-edits/${EDIT}`, 'POST', { action: 'reject', reason: 'не та цифра' }), params);
    expect(res.status).toBe(200);
    expect(notify).toHaveBeenCalledWith({ partnerId: PARTNER, subject: 'car_rental', label: 'Suzuki Jimny', outcome: 'rejected', reason: 'не та цифра' });
  });
});
