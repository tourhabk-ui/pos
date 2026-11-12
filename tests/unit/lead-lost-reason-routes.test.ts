/**
 * Двери сайта: «Отказ» по заявке принимается только с причиной (этап 3а).
 *
 * Судится вызовом роутов кабинета оператора (`PATCH /api/leads/[id]`) и раздела
 * «Свои туры» гида (`PATCH /api/guide/own/leads/[id]`): что ушло в запись, что
 * отправлено человеку и что ответила дверь. Право на заявку и сам запрос
 * записи держат свои сторожа (leads-idor, сцена «этап 3а» на настоящем
 * PostgreSQL) — здесь запись подменена, а скоуп кабинета считает настоящий
 * `operatorLeadScope` от подменённой проверки доступа.
 *
 * Правила:
 *  - продавец (оператор с карточкой, гид) не закрывает заявку «Отказ» без причины;
 *  - причина не из списка, причина с другой отметкой и причина не от продавца
 *    отклоняются словами — молча принять и не записать её нельзя (§4.0);
 *  - администратор и оператор без карточки закрывают как раньше, без причины:
 *    сообщение «оператор отказал» от них было бы неправдой;
 *  - «туристу сообщено» в ответе двери — по исходу отправки.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  change: vi.fn(), deliver: vi.fn(), access: vi.fn(), query: vi.fn(), bookings: vi.fn(),
  user: { userId: '11111111-1111-4111-8111-111111111111', role: 'operator', email: 'op@example.com' },
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) } }));
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: async () => h.user,
  requireAdmin: async () => h.user,
  requireRole: async () => ({ userId: 'u-guide', role: 'guide', email: 'g@example.com' }),
}));
vi.mock('@/lib/auth/guide-helpers', () => ({ getGuidePartnerId: async () => 'p-guide' }));
vi.mock('@/lib/operators/team-access', async (orig) => ({
  ...(await orig<typeof import('@/lib/operators/team-access')>()),
  operatorAccess: (...a: unknown[]) => h.access(...a),
}));
vi.mock('@/lib/leads/owner-lead-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/leads/owner-lead-status')>()),
  changeLeadStatus: (...a: unknown[]) => h.change(...a),
}));
vi.mock('@/lib/requests/answer-notice', () => ({ deliverAnswerNotice: (...a: unknown[]) => h.deliver(...a) }));
vi.mock('@/lib/leads/lead-bookings', () => ({ bookingsForLead: (...a: unknown[]) => h.bookings(...a) }));

import { GET as operatorGet, PATCH as operatorPatch } from '@/app/api/leads/[id]/route';
import { PATCH as guidePatch } from '@/app/api/guide/own/leads/[id]/route';
import {
  LOST_REASONS, LOST_REASON_ONLY_WITH_LOST, LOST_REASON_REQUIRED, LOST_REASON_SELLER_ONLY, LOST_REASON_UNKNOWN,
} from '@/lib/leads/lost-reason';
import { CLIENT_REASON_LINE, NOT_ADDRESSED_LINE } from '@/lib/leads/seller-lost-flow';

const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OP_USER = '11111111-1111-4111-8111-111111111111';

function closedOk(notice: { id: string; state: 'pending' | 'skipped'; skipped: string | null } | null) {
  return {
    kind: 'ok', changed: true, prevStatus: 'new', lead: { id: LEAD, status: 'lost', notes: null },
    closed: { activityId: '9', notice },
  };
}
const plainOk = (status: string) => ({ kind: 'ok', changed: true, prevStatus: 'new', lead: { id: LEAD, status, notes: null } });

const patch = (handler: typeof operatorPatch, body: unknown) => handler(
  new NextRequest(`http://localhost/api/leads/${LEAD}`, { method: 'PATCH', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: LEAD }) },
);

beforeEach(() => {
  for (const f of [h.change, h.deliver, h.access, h.query, h.bookings]) f.mockReset();
  h.user = { userId: OP_USER, role: 'operator', email: 'op@example.com' };
  h.access.mockResolvedValue({ kind: 'owner', partnerId: 'p-op' });
  h.change.mockResolvedValue(plainOk('lost'));
  h.deliver.mockResolvedValue({ state: 'delivered', via: 'max', dates: [] });
  h.bookings.mockResolvedValue({ kind: 'ok', rows: [] });
});

describe('кабинет оператора: PATCH /api/leads/[id]', () => {
  it('«Отказ» без причины не принимается, и запись не зовётся', async () => {
    const res = await patch(operatorPatch, { status: 'lost' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: LOST_REASON_REQUIRED });
    expect(h.change).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('причина не из списка и причина с другой отметкой — отказ словами, заявка не тронута', async () => {
    const garbage = await patch(operatorPatch, { status: 'lost', lostReason: 'просто так' });
    expect(garbage.status).toBe(422);
    expect(await garbage.json()).toEqual({ error: LOST_REASON_UNKNOWN });

    const wrongStatus = await patch(operatorPatch, { status: 'contacted', lostReason: 'seats' });
    expect(wrongStatus.status).toBe(422);
    expect(await wrongStatus.json()).toEqual({ error: LOST_REASON_ONLY_WITH_LOST });

    const notesOnly = await patch(operatorPatch, { notes: 'перезвонить', lostReason: 'seats' });
    expect(notesOnly.status).toBe(422);
    expect(h.change).not.toHaveBeenCalled();
  });

  it('отказ продавца: в запись уходит причина и его карточка, сообщение отправлено, ответ говорит исход', async () => {
    h.change.mockResolvedValue(closedOk({ id: '77', state: 'pending', skipped: null }));
    const res = await patch(operatorPatch, { status: 'lost', lostReason: 'seats', notes: 'группа набрана' });
    expect(res.status).toBe(200);
    expect(h.change).toHaveBeenCalledTimes(1);
    expect(h.change).toHaveBeenCalledWith({
      leadId: LEAD, status: 'lost', notes: 'группа набрана',
      actor: { kind: 'partner_user', userId: OP_USER },
      scope: { kind: 'owner', partnerId: 'p-op', claimUnowned: true },
      via: 'site', lost: { reason: 'seats', partnerId: 'p-op' },
    });
    expect(h.deliver).toHaveBeenCalledWith('77');
    expect(await res.json()).toEqual({
      success: true, changed: true, lead: { id: LEAD, status: 'lost', notes: null },
      tourist: 'Туристу ушло сообщение в MAX: ваш ответ.',
    });
  });

  it('каждая причина из списка принимается; у причины клиента отправки нет', async () => {
    for (const reason of LOST_REASONS) {
      h.change.mockReset(); h.deliver.mockReset();
      h.change.mockResolvedValue(closedOk(null));
      const res = await patch(operatorPatch, { status: 'lost', lostReason: reason });
      expect(res.status, reason).toBe(200);
      expect(h.change.mock.calls[0][0].lost, reason).toEqual({ reason, partnerId: 'p-op' });
      expect(h.deliver, reason).not.toHaveBeenCalled();
    }
    h.change.mockResolvedValue(closedOk(null));
    const res = await patch(operatorPatch, { status: 'lost', lostReason: 'client_declined' });
    expect((await res.json()).tourist).toBe(CLIENT_REASON_LINE);
  });

  it('заявка была ничейной — продавцу сказано, что туристу ничего не ушло', async () => {
    h.change.mockResolvedValue(closedOk({ id: '77', state: 'skipped', skipped: 'not_addressee' }));
    const res = await patch(operatorPatch, { status: 'lost', lostReason: 'dates' });
    expect((await res.json()).tourist).toBe(NOT_ADDRESSED_LINE);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('другие отметки идут как раньше: без причины, и про туриста ответ молчит', async () => {
    h.change.mockResolvedValue(plainOk('contacted'));
    const res = await patch(operatorPatch, { status: 'contacted' });
    expect(res.status).toBe(200);
    const args = h.change.mock.calls[0][0];
    expect(args.status).toBe('contacted');
    expect('lost' in args).toBe(false);
    expect((await res.json()).tourist).toBeNull();
  });

  it('администратор закрывает без причины, как раньше; причина от него не принимается', async () => {
    h.user = { userId: 'u-adm', role: 'admin', email: 'adm@example.com' };
    const closed = await patch(operatorPatch, { status: 'lost' });
    expect(closed.status).toBe(200);
    const args = h.change.mock.calls[0][0];
    expect(args).toMatchObject({ status: 'lost', actor: { kind: 'admin', userId: 'u-adm' }, scope: { kind: 'admin' } });
    expect('lost' in args).toBe(false);
    expect((await closed.json()).tourist).toBeNull();
    expect(h.deliver).not.toHaveBeenCalled();

    h.change.mockClear();
    const withReason = await patch(operatorPatch, { status: 'lost', lostReason: 'seats' });
    expect(withReason.status).toBe(422);
    expect(await withReason.json()).toEqual({ error: LOST_REASON_SELLER_ONLY });
    expect(h.change).not.toHaveBeenCalled();
  });

  it('оператор без карточки партнёра — не продавец: без причины закрывает, с причиной — отказ', async () => {
    h.access.mockResolvedValue({ kind: 'none', reason: 'no_profile' });
    const closed = await patch(operatorPatch, { status: 'lost' });
    expect(closed.status).toBe(200);
    expect(h.change.mock.calls[0][0]).toMatchObject({ status: 'lost', scope: { kind: 'unowned_only' } });
    expect('lost' in h.change.mock.calls[0][0]).toBe(false);

    h.change.mockClear();
    const withReason = await patch(operatorPatch, { status: 'lost', lostReason: 'seats' });
    expect(withReason.status).toBe(422);
    expect(h.change).not.toHaveBeenCalled();
  });

  it('менеджер команды оператора — продавец: причина обязательна и записывается на карточку оператора', async () => {
    h.access.mockResolvedValue({ kind: 'manager', partnerId: 'p-team', memberId: 'm-1', perms: { canEditPrices: false, canCancelBookings: false } });
    expect((await patch(operatorPatch, { status: 'lost' })).status).toBe(422);
    h.change.mockResolvedValue(closedOk(null));
    await patch(operatorPatch, { status: 'lost', lostReason: 'no_contact' });
    expect(h.change.mock.calls[0][0].lost).toEqual({ reason: 'no_contact', partnerId: 'p-team' });
  });

  it('отказ не записан (не найдена, отменена клиентом) — ответ прежний, про туриста ни слова', async () => {
    h.change.mockResolvedValue({ kind: 'not_found' });
    const missing = await patch(operatorPatch, { status: 'lost', lostReason: 'seats' });
    expect(missing.status).toBe(404);
    h.change.mockResolvedValue({ kind: 'ok', changed: false, prevStatus: 'cancelled', lead: { id: LEAD, status: 'cancelled', notes: null } });
    const cancelled = await patch(operatorPatch, { status: 'lost', lostReason: 'seats' });
    expect(cancelled.status).toBe(409);
    expect(JSON.stringify(await cancelled.json())).not.toMatch(/Туристу/);
    expect(h.deliver).not.toHaveBeenCalled();
  });
});

describe('кабинет оператора: GET /api/leads/[id] говорит экрану, спрашивать ли причину', () => {
  const get = () => operatorGet(
    new NextRequest(`http://localhost/api/leads/${LEAD}`),
    { params: Promise.resolve({ id: LEAD }) },
  );
  const row = { id: LEAD, status: 'lost', lost_reason: 'weather', source_url: null, source_data: null, pd_consent_source: null };

  it('продавцу с карточкой — да; причина закрытой заявки отдана', async () => {
    h.query.mockResolvedValue({ rows: [row] });
    const body = await (await get()).json();
    expect(body.lost_needs_reason).toBe(true);
    expect(body.lead.lost_reason).toBe('weather');
    // Причина читается той же строкой, что и заявка, — под тем же условием владения.
    const [sql, params] = h.query.mock.calls[0];
    expect(String(sql)).toMatch(/lost_reason/);
    expect(params).toEqual([LEAD, 'p-op']);
  });

  it('администратору и оператору без карточки — нет', async () => {
    h.query.mockResolvedValue({ rows: [row] });
    h.user = { userId: 'u-adm', role: 'admin', email: 'adm@example.com' };
    expect((await (await get()).json()).lost_needs_reason).toBe(false);
    h.user = { userId: OP_USER, role: 'operator', email: 'op@example.com' };
    h.access.mockResolvedValue({ kind: 'none', reason: 'no_profile' });
    expect((await (await get()).json()).lost_needs_reason).toBe(false);
  });
});

describe('«Свои туры» гида: PATCH /api/guide/own/leads/[id]', () => {
  it('«Отказ» без причины, с причиной не из списка и причина с другой отметкой — не принимаются', async () => {
    const bare = await patch(guidePatch, { status: 'lost' });
    expect(bare.status).toBe(422);
    expect(await bare.json()).toEqual({ success: false, error: LOST_REASON_REQUIRED });

    const garbage = await patch(guidePatch, { status: 'lost', lostReason: 'просто так' });
    expect(garbage.status).toBe(422);
    expect(await garbage.json()).toEqual({ success: false, error: LOST_REASON_UNKNOWN });

    const wrongStatus = await patch(guidePatch, { status: 'contacted', lostReason: 'seats' });
    expect(wrongStatus.status).toBe(422);
    expect(await wrongStatus.json()).toEqual({ success: false, error: LOST_REASON_ONLY_WITH_LOST });
    expect(h.change).not.toHaveBeenCalled();
  });

  it('отметка не из списка по-прежнему 400 со списком отметок — не слова о причине', async () => {
    const res = await patch(guidePatch, { status: 'new' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/связался/);
  });

  it('отказ с причиной: скоуп гида (только адресованные ему), причина на его карточку, исход отправки в ответе', async () => {
    h.change.mockResolvedValue(closedOk({ id: '78', state: 'pending', skipped: null }));
    h.deliver.mockResolvedValue({ state: 'undelivered', manager: 'max', why: { chat: 'none', agent: 'none', broken: false } });
    const res = await patch(guidePatch, { status: 'lost', lostReason: 'weather' });
    expect(res.status).toBe(200);
    expect(h.change).toHaveBeenCalledWith({
      leadId: LEAD, status: 'lost', notes: undefined,
      actor: { kind: 'partner_user', userId: 'u-guide' },
      scope: { kind: 'owner', partnerId: 'p-guide', claimUnowned: false },
      via: 'site', lost: { reason: 'weather', partnerId: 'p-guide' },
    });
    expect(h.deliver).toHaveBeenCalledWith('78');
    const body = await res.json();
    expect(body).toMatchObject({ success: true, changed: true, data: { id: LEAD, status: 'lost' } });
    expect(body.tourist).toMatch(/^Туристу сообщить не удалось/);
  });

  it('другие отметки гида идут без причины, про туриста ответ молчит', async () => {
    h.change.mockResolvedValue(plainOk('qualified'));
    const res = await patch(guidePatch, { status: 'qualified' });
    expect(res.status).toBe(200);
    expect('lost' in h.change.mock.calls[0][0]).toBe(false);
    expect((await res.json()).tourist).toBeNull();
  });
});
