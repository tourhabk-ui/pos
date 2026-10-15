/**
 * Оператор закрепляет туры наверху своей страницы (1267).
 *
 * Повод — просьба оператора «Местечко Камчатка», переданная владельцем 15.10:
 * «нужен упор на вертолётные экскурсии». Порядок туров на странице оператора
 * задавался только сезоном, «Курильское озеро (вертолёт)» стояло последним из
 * пятнадцати, а выбрать порядок самому оператору было нечем.
 *
 * Сторож — вызовом PATCH тура (что уходит в UPDATE) и схемой; порядок страницы
 * и миграция — их SQL по смыслу.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const { clientQuery, getTourByIdMock } = vi.hoisted(() => ({ clientQuery: vi.fn(), getTourByIdMock: vi.fn() }));

vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn(async () => ({ userId: 'user-pavel', role: 'operator' })),
}));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: vi.fn(async () => 'op-mestechko') }));
vi.mock('@/lib/operators/team-access', () => ({ requireTeamPermission: vi.fn(async () => null) }));
vi.mock('@/lib/operators/team-money', () => ({ changesTourPrice: () => false }));
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: vi.fn() }));
vi.mock('@/lib/db/column-types', () => ({ getColumnTypes: vi.fn(async () => new Map()), valueForColumn: (v: unknown) => v }));
vi.mock('@/lib/database', () => ({
  transaction: async (fn: (c: { query: typeof clientQuery }) => unknown) => fn({ query: clientQuery }),
}));
vi.mock('@/lib/api/operator-tours', async (orig) => {
  const real = await orig<typeof import('@/lib/api/operator-tours')>();
  return { ...real, getTourById: getTourByIdMock, softDeleteTour: vi.fn() };
});

import { PATCH } from '@/app/api/hub/operator/tours/[id]/route';
import { UpdateTourSchema } from '@/lib/api/operator-tours';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const patch = (body: unknown) => PATCH(
  new NextRequest('https://vedarai.ru/api/hub/operator/tours/51', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: '51' }) },
);

beforeEach(() => {
  clientQuery.mockReset();
  clientQuery.mockResolvedValue({ rows: [{ id: '51', title: 'Курильское озеро (вертолёт)', updated_at: 'now' }] });
  getTourByIdMock.mockReset();
  getTourByIdMock.mockResolvedValue({ id: '51', operator_id: 'op-mestechko', base_price: 180000 });
});

describe('PATCH тура: поле pinned', () => {
  it('pinned: true — закрепляет, не сдвигая прежний момент закрепления', async () => {
    const res = await patch({ pinned: true });
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(200);
    const [sql, values] = clientQuery.mock.calls[0];
    expect(sql).toMatch(/pinned_at = CASE WHEN \$1::boolean THEN COALESCE\(pinned_at, NOW\(\)\) ELSE NULL END/);
    expect(values[0]).toBe(true);
  });

  it('pinned: false — снимает закрепление', async () => {
    await patch({ pinned: false, title: 'Курильское озеро (вертолёт)' });
    const [sql, values] = clientQuery.mock.calls[0];
    expect(sql).toMatch(/pinned_at = CASE WHEN \$\d+::boolean/);
    expect(values).toContain(false);
  });

  it('поле не прислано — закрепление не трогается', async () => {
    await patch({ title: 'Курильское озеро (вертолёт)' });
    const [sql] = clientQuery.mock.calls[0];
    expect(sql).not.toMatch(/pinned_at/);
  });

  it('чужой тур закрепить нельзя: 404 и UPDATE не уходит', async () => {
    getTourByIdMock.mockResolvedValue({ id: '51', operator_id: 'op-other' });
    const res = await patch({ pinned: true });
    expect(res.status).toBe(404);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('схема: pinned — только булево', () => {
    expect(UpdateTourSchema.safeParse({ pinned: true }).success).toBe(true);
    expect(UpdateTourSchema.safeParse({ pinned: 'да' }).success).toBe(false);
  });
});

describe('страница оператора и миграция — SQL по смыслу', () => {
  it('закреплённые первыми и по моменту закрепления, остальные — по сезону, как раньше', () => {
    const page = read('app/operators/[slug]/page.tsx');
    expect(page).toMatch(/ORDER BY \(ot\.pinned_at IS NULL\), ot\.pinned_at, ot\.season_start NULLS LAST, ot\.id/);
  });

  it('1267: колонка заводится идемпотентно и без данных', () => {
    const sql = read('migrations/1267_operator_tours_pinned_at.sql');
    expect(sql).toMatch(/ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ/);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/im);
  });
});

describe('1268: «Местечку» закреплены пять вертолётных туров (владелец 15.10)', () => {
  const sql = read('migrations/1268_mestechko_pin_helicopter_tours.sql');

  it('ровно пять вертолётных slug-ов, в задуманном порядке; черновик не закрепляется', () => {
    const slugs = [...sql.matchAll(/\('(mestechko-[a-z0-9-]+)',\s*TIMESTAMPTZ '([^']+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(slugs.map(([s]) => s)).toEqual([
      'mestechko-dolina-geyzerov',
      'mestechko-kurilskoe-ozero',
      'mestechko-vertolet-tolbachik',
      'mestechko-oblet-vilyuchinskiy-mutnovskiy-gorelyy',
      'mestechko-oblet-koryakskiy-avachinskiy',
    ]);
    const times = slugs.map(([, t]) => Date.parse(t.replace(' ', 'T').replace('+00', 'Z')));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(5);
    expect(sql).not.toMatch(/\('mestechko-dolina-geyzerov-tolbachik'/);
  });

  it('гейт по партнёру и только поверх незакреплённых: выбор оператора не перетирается', () => {
    expect(sql).toMatch(/p\.slug = 'mestechko'/);
    expect(sql).toMatch(/ot\.operator_id(::text)? = p\.id(::text)?/);
    expect(sql).toMatch(/ot\.pinned_at IS NULL/);
    expect(sql).toMatch(/ot\.deleted_at IS NULL/);
  });
});
