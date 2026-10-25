/**
 * Решение администратора: одобрение пишет живую строку в той же транзакции,
 * отказ — нет. Без прав администратора запроса к правке нет.
 * Одобряется только то, что модератор видел: черновик, переписанный после
 * показа карточки, — 409 и прайс прежний.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const query = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();
const requireAdmin = vi.fn();

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => query(...a),
    connect: async () => ({ query: clientQuery, release }),
  },
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...a: unknown[]) => requireAdmin(...a),
}));

const ID = '33333333-3333-4333-8333-333333333333';
const OFFER = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  query.mockReset();
  clientQuery.mockReset();
  release.mockReset();
  requireAdmin.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  requireAdmin.mockResolvedValue({ userId: '44444444-4444-4444-8444-444444444444', role: 'admin' });
});

function post(body: unknown) {
  return new NextRequest('https://vedarai.ru/api/admin/moderation/rental-edits/' + ID, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST решения по правке', () => {
  it('без администратора базу не трогает', async () => {
    requireAdmin.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));
    const { POST } = await import('@/app/api/admin/moderation/rental-edits/[id]/route');
    const res = await POST(post({ action: 'approve', seenPrice: 8500, seenConditions: null }), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(401);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('одобрение обновляет прайс и ставит approved', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/FOR UPDATE/.test(sql)) {
        return { rows: [{
          id: ID, offer_id: OFFER, partner_id: PARTNER,
          price_rub_per_day: 8500, conditions: 'новый текст',
          moderation_status: 'pending', title: 'Suzuki Jimny',
        }] };
      }
      if (/UPDATE car_rental_offers/.test(sql)) return { rows: [{ id: OFFER }] };
      if (/UPDATE rental_offer_edits/.test(sql)) return { rows: [{ id: ID }] };
      return { rows: [] };
    });
    const { POST } = await import('@/app/api/admin/moderation/rental-edits/[id]/route');
    const res = await POST(post({ action: 'approve', seenPrice: 8500, seenConditions: 'новый текст' }), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(200);
    const apply = clientQuery.mock.calls.find((c) => /UPDATE car_rental_offers/.test(String(c[0])));
    expect(apply?.[1]).toEqual([OFFER, 8500, 'новый текст', PARTNER]);
    const mark = clientQuery.mock.calls.find((c) => /UPDATE rental_offer_edits/.test(String(c[0])));
    expect(mark?.[1]?.[1]).toBe('approved');
    expect(String(clientQuery.mock.calls.at(-1)?.[0])).toBe('COMMIT');
  });

  function lockedDraft(price: number | null, conditions: string | null) {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/FOR UPDATE/.test(sql)) {
        return { rows: [{
          id: ID, offer_id: OFFER, partner_id: PARTNER,
          price_rub_per_day: price, conditions,
          moderation_status: 'pending', title: 'Suzuki Jimny',
        }] };
      }
      if (/UPDATE car_rental_offers/.test(sql)) return { rows: [{ id: OFFER }] };
      if (/UPDATE rental_offer_edits/.test(sql)) return { rows: [{ id: ID }] };
      return { rows: [] };
    });
  }

  it('черновик переписан после показа — 409, прайс и черновик не тронуты', async () => {
    // Модератор видел 8 000, прокатчик тем временем прислал 80 000 в ту же строку.
    lockedDraft(80000, null);
    const { POST } = await import('@/app/api/admin/moderation/rental-edits/[id]/route');
    const res = await POST(post({ action: 'approve', seenPrice: 8000, seenConditions: null }), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(409);
    const body = await res.json() as { success: boolean; code?: string; error: string };
    expect(body).toMatchObject({ success: false, code: 'changed' });
    expect(body.error).toContain('Прайс не изменён');
    expect(clientQuery.mock.calls.some((c) => /UPDATE car_rental_offers/.test(String(c[0])))).toBe(false);
    expect(clientQuery.mock.calls.some((c) => /UPDATE rental_offer_edits/.test(String(c[0])))).toBe(false);
    expect(String(clientQuery.mock.calls.at(-1)?.[0])).toBe('ROLLBACK');
  });

  it('описание дописано после показа — тоже 409', async () => {
    lockedDraft(8000, 'Без пробега');
    const { POST } = await import('@/app/api/admin/moderation/rental-edits/[id]/route');
    const res = await POST(post({ action: 'approve', seenPrice: 8000, seenConditions: null }), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(409);
    expect(clientQuery.mock.calls.some((c) => /UPDATE car_rental_offers/.test(String(c[0])))).toBe(false);
  });

  it('одобрение без того, что видел модератор, не принимается', async () => {
    lockedDraft(8000, null);
    const { POST } = await import('@/app/api/admin/moderation/rental-edits/[id]/route');
    const res = await POST(post({ action: 'approve' }), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Обновите страницу');
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('отказ живую строку не пишет', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (/FOR UPDATE/.test(sql)) {
        return { rows: [{
          id: ID, offer_id: OFFER, partner_id: PARTNER,
          price_rub_per_day: 16000, conditions: null,
          moderation_status: 'pending', title: 'Tank-300',
        }] };
      }
      if (/UPDATE rental_offer_edits/.test(sql)) return { rows: [{ id: ID }] };
      return { rows: [] };
    });
    const { POST } = await import('@/app/api/admin/moderation/rental-edits/[id]/route');
    const res = await POST(post({ action: 'reject', reason: 'не та цифра' }), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('прежняя строка');
    expect(clientQuery.mock.calls.some((c) => /UPDATE car_rental_offers/.test(String(c[0])))).toBe(false);
  });
});

describe('GET очереди', () => {
  it('отдаёт правку без телефона; отказ базы — 503, не пустой список', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: ID, offer_id: OFFER, partner_name: 'Лагуна Прокат', partner_slug: 'laguna-prokat',
      title: 'Suzuki Jimny', live_price: 7000, price_is_from: false, live_conditions: null,
      draft_price: 8500, draft_conditions: null, created_at: '2026-10-24T01:00:00Z',
    }] });
    const { GET } = await import('@/app/api/admin/moderation/rental-edits/route');
    const ok = await GET(new NextRequest('https://vedarai.ru/api/admin/moderation/rental-edits'));
    const json = await ok.json() as { data: { edits: Array<Record<string, unknown>> } };
    expect(ok.status).toBe(200);
    expect(json.data.edits[0]?.draftPrice).toBe(8500);
    expect(JSON.stringify(json)).not.toMatch(/phone|email|\+7/i);
    expect(String(query.mock.calls[0][0])).not.toMatch(/phone|email/);

    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    const bad = await GET(new NextRequest('https://vedarai.ru/api/admin/moderation/rental-edits'));
    expect(bad.status).toBe(503);
    const err = await bad.json() as { success: boolean; data?: unknown };
    expect(err.success).toBe(false);
    expect(err.data).toBeUndefined();
  });
});
