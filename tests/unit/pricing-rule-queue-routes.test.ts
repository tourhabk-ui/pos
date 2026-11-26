/**
 * Роуты очереди скидок и наценок: кто входит и что отвечает на каждый исход.
 *
 * Очередь и решение на схеме прода судит
 * tests/integration/pricing-rule-moderation.pg.test.ts. Здесь — то, чего
 * настоящая база не покажет: вход не администратора и отказ базы. «Не смог
 * прочитать» не должно выглядеть как «проверять нечего» (§4.0), а решение —
 * как записанное.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const ADMIN = 'c6000000-0000-4000-8000-0000000002ad';
const gate = vi.hoisted(() => ({
  admin: true, list: vi.fn(), decide: vi.fn(), notify: vi.fn(async (_n: Record<string, unknown>) => undefined), ping: vi.fn(),
}));
vi.mock('@/lib/auth/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireAdmin: vi.fn(async () => (gate.admin
      ? { userId: 'c6000000-0000-4000-8000-0000000002ad', role: 'admin' }
      : NextResponse.json({ success: false, error: 'Требуется вход администратора' }, { status: 401 }))),
  };
});
vi.mock('@/lib/tours/pricing-rule-review', () => ({ listPendingPricingRules: gate.list, decidePricingRule: gate.decide }));
vi.mock('@/lib/notifications/partner-edit-notify', () => ({ notifyPartnerEditDecisionQuietly: gate.notify }));
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: gate.ping }));

const SEEN = 'a'.repeat(64);
async function list() {
  const { GET } = await import('@/app/api/admin/moderation/pricing-rules/route');
  const res = await GET(new NextRequest('http://localhost/api/admin/moderation/pricing-rules'));
  return { status: res.status, body: await res.json() };
}
async function decide(id: string, body: unknown) {
  const { POST } = await import('@/app/api/admin/moderation/pricing-rules/[id]/route');
  const res = await POST(
    new NextRequest(`http://localhost/api/admin/moderation/pricing-rules/${id}`, { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}
const decided = (over: Record<string, unknown> = {}) => ({
  outcome: 'approved', kind: 'new', partnerId: 'partner-1', partnerCategory: 'operator',
  tourId: '7', tourTitle: 'Вулкан Горелый', words: 'Скидка на последние места: −15%, когда до выезда 7 дн. и меньше', ...over,
});

beforeEach(() => {
  gate.admin = true;
  gate.list.mockReset();
  gate.decide.mockReset();
  gate.notify.mockClear();
  gate.ping.mockClear();
});

describe('GET /api/admin/moderation/pricing-rules', () => {
  it('не администратор получает отказ входа, очередь не читается', async () => {
    gate.admin = false;
    const res = await list();
    expect(res.status).toBe(401);
    expect(gate.list).not.toHaveBeenCalled();
  });

  it('отказ базы — 503 и слова «не смог», а не пустая очередь', async () => {
    gate.list.mockResolvedValue({ outcome: 'db_error' });
    const res = await list();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: 'Не смог прочитать скидки и наценки на проверке' });
  });

  it('очередь отдана как есть; пустая — это «проверять нечего»', async () => {
    gate.list.mockResolvedValue({ outcome: 'ok', rules: [{ id: '5' }] });
    expect(await list()).toEqual({ status: 200, body: { success: true, data: { rules: [{ id: '5' }] } } });
    gate.list.mockResolvedValue({ outcome: 'ok', rules: [] });
    expect((await list()).body.data.rules).toEqual([]);
  });
});

describe('POST /api/admin/moderation/pricing-rules/[id]', () => {
  it('не администратор получает отказ входа, решение не записывается', async () => {
    gate.admin = false;
    const res = await decide('5', { action: 'approve', seen: SEEN });
    expect(res.status).toBe(401);
    expect(gate.decide).not.toHaveBeenCalled();
    expect(gate.notify).not.toHaveBeenCalled();
  });

  it('кривой запрос до решения не доходит: id не число, одобрение без отпечатка, отказ без причины, чужое действие', async () => {
    expect((await decide('5;drop', { action: 'approve', seen: SEEN })).status).toBe(400);
    expect((await decide('5', { action: 'approve' })).status).toBe(400);
    expect((await decide('5', { action: 'approve', seen: 'короткий' })).status).toBe(400);
    expect((await decide('5', { action: 'reject', reason: 'нет' })).status).toBe(400);
    expect((await decide('5', { action: 'reject' })).status).toBe(400);
    expect((await decide('5', { action: 'удалить' })).status).toBe(400);
    expect(gate.decide).not.toHaveBeenCalled();
  });

  it('одобрение: решению отданы id, отпечаток и кто решил; владельцу — сообщение, поисковикам — страница тура', async () => {
    gate.decide.mockResolvedValue(decided());
    const res = await decide('5', { action: 'approve', seen: SEEN });
    expect(res.status).toBe(200);
    expect(gate.decide).toHaveBeenCalledWith({ id: '5', action: 'approve', reason: null, moderatedBy: ADMIN, seen: SEEN });
    expect(res.body).toMatchObject({ success: true, message: '«Вулкан Горелый»: правило действует на сайте', data: { outcome: 'approved', kind: 'new', tourId: '7' } });
    expect(gate.ping).toHaveBeenCalledWith('7');
    expect(gate.notify.mock.calls[0][0]).toEqual({
      partnerId: 'partner-1', subject: 'pricing_rule', label: 'Вулкан Горелый', outcome: 'approved', reason: null,
      ruleWords: 'Скидка на последние места: −15%, когда до выезда 7 дн. и меньше', ruleKind: 'new',
    });
  });

  it('отказ: причина доходит до решения и до владельца; цена не менялась — поисковикам сообщать нечего', async () => {
    gate.decide.mockResolvedValue(decided({ outcome: 'rejected' }));
    const res = await decide('5', { action: 'reject', reason: '  Скидка 50% без объяснения.  ' });
    expect(res.status).toBe(200);
    expect(gate.decide).toHaveBeenCalledWith({ id: '5', action: 'reject', reason: 'Скидка 50% без объяснения.', moderatedBy: ADMIN, seen: null });
    expect(res.body.message).toBe('«Вулкан Горелый»: правило отклонено, цена прежняя');
    expect(gate.ping).not.toHaveBeenCalled();
    expect(gate.notify.mock.calls[0][0]).toMatchObject({ outcome: 'rejected', reason: 'Скидка 50% без объяснения.' });
  });

  it('снятие: слова ответа — про снятие, а не про новое правило', async () => {
    gate.decide.mockResolvedValue(decided({ kind: 'removal' }));
    expect((await decide('5', { action: 'approve', seen: SEEN })).body.message).toBe('«Вулкан Горелый»: правило снято');
    gate.decide.mockResolvedValue(decided({ kind: 'removal', outcome: 'rejected' }));
    expect((await decide('5', { action: 'reject', reason: 'Скидка обещана до конца месяца.' })).body.message)
      .toBe('«Вулкан Горелый»: в снятии отказано, правило действует');
    expect(gate.notify.mock.calls.map((c) => c[0].ruleKind)).toEqual(['removal', 'removal']);
  });

  it('решение не записано — владельцу ничего не уходит: отказ базы 503, нет правила 404, изменилось и уже решено — 409', async () => {
    gate.decide.mockResolvedValue({ outcome: 'db_error' });
    const down = await decide('5', { action: 'approve', seen: SEEN });
    expect(down.status).toBe(503);
    expect(down.body.error).toBe('Не смог записать решение. Цена не изменена.');
    gate.decide.mockResolvedValue({ outcome: 'not_found' });
    expect((await decide('5', { action: 'approve', seen: SEEN })).status).toBe(404);
    gate.decide.mockResolvedValue({ outcome: 'changed' });
    const changed = await decide('5', { action: 'approve', seen: SEEN });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('changed');
    gate.decide.mockResolvedValue({ outcome: 'already' });
    const already = await decide('5', { action: 'approve', seen: SEEN });
    expect(already.status).toBe(409);
    expect(already.body.code).toBeUndefined();
    expect(gate.notify).not.toHaveBeenCalled();
    expect(gate.ping).not.toHaveBeenCalled();
  });
});
