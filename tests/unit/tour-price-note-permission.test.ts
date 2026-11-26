/**
 * Примечание к цене охраняется тем же правом, что и цена (ревью безопасности
 * PR #3835, 26.11).
 *
 * Импорт с сайта оператора пишет `price_note` дверью правки, поэтому поле
 * приняла и схема правки владельца. Турист читает его рядом с суммой, а
 * «что считается ценой» (`TOUR_PRICE_FIELDS`) его не знало: менеджер команды
 * без права `can_edit_prices` мог прислать «Акция: 5 000 ₽ с человека» — и
 * правка ушла бы в очередь от имени кабинета, мимо запрета владельца.
 *
 * Сторож — вызовом двери владельца: правило «что считается ценой» настоящее,
 * подменён только ответ о праве менеджера.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { clientQuery, getTourByIdMock, permission } = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  getTourByIdMock: vi.fn(),
  permission: { asked: [] as string[], granted: false },
}));

vi.mock('@/lib/auth/middleware', () => ({ requireOperator: vi.fn(async () => ({ userId: 'user-manager', role: 'operator' })) }));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: vi.fn(async () => 'op-test') }));
vi.mock('@/lib/operators/team-access', () => ({
  requireTeamPermission: vi.fn(async (_userId: string, name: string) => {
    permission.asked.push(name);
    return permission.granted
      ? null
      : NextResponse.json({ error: 'Цены меняет владелец кабинета или менеджер, которому он это разрешил' }, { status: 403 });
  }),
}));
vi.mock('@/lib/tours/tour-change', async () => (await import('../helpers/tour-change-passthrough')).tourChangePassthrough());
vi.mock('@/lib/tours/moderation-store', async () => (await import('../helpers/tour-change-passthrough')).noTourEdits());
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: vi.fn() }));
vi.mock('@/lib/db/column-types', () => ({ getColumnTypes: vi.fn(async () => new Map()), valueForColumn: (v: unknown) => v }));
vi.mock('@/lib/storage/s3', () => ({ s3PublicUrl: (k: string) => `https://s3.test/bucket/${k}` }));
vi.mock('@/lib/database', () => ({
  transaction: async (fn: (c: { query: typeof clientQuery }) => unknown) => fn({ query: clientQuery }),
}));
vi.mock('@/lib/api/operator-tours', async (orig) => {
  const real = await orig<typeof import('@/lib/api/operator-tours')>();
  return { ...real, getTourById: getTourByIdMock, softDeleteTour: vi.fn() };
});

import { PATCH } from '@/app/api/hub/operator/tours/[id]/route';

const patch = (body: unknown) => PATCH(
  new NextRequest('https://vedarai.ru/api/hub/operator/tours/51', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: '51' }) },
);
const tourUpdate = () => clientQuery.mock.calls
  .map(([sql, values]) => ({ sql: String(sql), values: values as unknown[] }))
  .find((c) => /UPDATE operator_tours/.test(c.sql));

const STORED = { id: '51', operator_id: 'op-test', title: 'Тест', base_price: '12000.00', price_unit: 'per_person', price_old: null, price_note: 'Дети до 7 лет бесплатно' };

beforeEach(() => {
  permission.asked = [];
  permission.granted = false;
  clientQuery.mockReset();
  clientQuery.mockResolvedValue({ rows: [{ id: '51', title: 'Тест', updated_at: 'now' }] });
  getTourByIdMock.mockReset();
  getTourByIdMock.mockResolvedValue({ ...STORED });
});

describe('менеджер без права цен и примечание к цене', () => {
  it('новое примечание — 403 словами о цене, в тур ничего не записано', async () => {
    const res = await patch({ price_note: 'Акция: 5 000 ₽ с человека, оплата на месте' });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toContain('Цены меняет владелец кабинета');
    expect(permission.asked).toEqual(['can_edit_prices']);
    expect(tourUpdate()).toBeUndefined();
  });

  it('снять примечание — тоже правка цены', async () => {
    const res = await patch({ price_note: null });
    expect(res.status).toBe(403);
    expect(tourUpdate()).toBeUndefined();
  });

  it('то же примечание вместе с новым описанием — не правка цены: описание сохраняется, право не спрашивается', async () => {
    const res = await patch({ description: 'Новое описание тура', price_note: 'Дети до 7 лет бесплатно' });
    expect(res.status).toBe(200);
    expect(permission.asked).toEqual([]);
    expect(tourUpdate()?.sql).toMatch(/description = \$\d+/);
  });

  it('одно описание — право на цены не спрашивается', async () => {
    const res = await patch({ description: 'Новое описание тура' });
    expect(res.status).toBe(200);
    expect(permission.asked).toEqual([]);
  });
});

describe('менеджер с правом цен', () => {
  it('примечание к цене уходит в правку тура', async () => {
    permission.granted = true;
    const res = await patch({ price_note: 'Дети до 12 лет бесплатно' });
    expect(res.status).toBe(200);
    expect(permission.asked).toEqual(['can_edit_prices']);
    const update = tourUpdate();
    expect(update?.sql).toMatch(/price_note = \$\d+/);
    expect(update?.values).toContain('Дети до 12 лет бесплатно');
  });
});
