// @vitest-environment node
/**
 * Отзывы о перевозчике — двери API (миграция 1235; слово владельца 13.10:
 * «делай блок отзывов но логично»). Сторож держит:
 *
 *   · анонимного пути нет: POST публичен только потому, что у заказчика
 *     машины доказательство — ключ ссылки; пути «место в поездке» нет —
 *     машину заказывают целиком (владелец 13.10);
 *   · подпись по ссылке — имя буквами, иначе отказ с полем и без записи;
 *   · отказы — словами правила с честным кодом (404 «ссылка не найдена», 410
 *     «использована/устарела»); отказ базы — 503 и строка с SQLSTATE в логе,
 *     а не «нет такого»;
 *   · ссылку выдаёт только администратор и только с даты выезда; ключ — во
 *     фрагменте;
 *   · скрыть — с причиной не короче 8; экран менеджера получает «можно ли
 *     подтвердить» тем же правилом, что проверит выдача;
 *   · публичный блок считает и показывает только видимые отзывы.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findPublicCarrier: vi.fn(),
  writeInviteReview: vi.fn(),
  checkInvite: vi.fn(),
  issueCharterInvite: vi.fn(),
  listCarrierReviewsForAdmin: vi.fn(),
  listCharterLeadsForAdmin: vi.fn(),
  setCarrierReviewHidden: vi.fn(),
  dbQuery: vi.fn(),
}));

vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: m.requireAdmin }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.dbQuery(...a), transaction: vi.fn() }));
vi.mock('@/lib/transfers/carrier-reviews', async (orig) => ({
  ...(await orig<typeof import('@/lib/transfers/carrier-reviews')>()),
  findPublicCarrier: m.findPublicCarrier,
  writeInviteReview: m.writeInviteReview,
  checkInvite: m.checkInvite,
  issueCharterInvite: m.issueCharterInvite,
  listCarrierReviewsForAdmin: m.listCarrierReviewsForAdmin,
  listCharterLeadsForAdmin: m.listCharterLeadsForAdmin,
  setCarrierReviewHidden: m.setCarrierReviewHidden,
}));

import { POST as postReview } from '@/app/api/carrier-reviews/route';
import { POST as postInviteCheck } from '@/app/api/carrier-reviews/invite/route';
import { POST as postIssue } from '@/app/api/admin/carrier-reviews/invites/route';
import { PATCH as patchReview } from '@/app/api/admin/carrier-reviews/[id]/route';
import { GET as getAdmin } from '@/app/api/admin/carrier-reviews/route';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';
import { loadCarrierReviews } from '@/lib/transfers/carrier-reviews';
import { kamchatkaToday } from '@/lib/seat-requests/core';

const CARRIER = { partnerId: 'p-1', slug: 'shatun', name: 'Шатун' };
const KEY = 'K'.repeat(32);
let ip = 0;
const req = (url: string, init?: { method?: string; body?: unknown }) => {
  ip += 1;
  return new NextRequest(`https://vedarai.ru${url}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.9.${Math.floor(ip / 250)}.${ip % 250}` },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.findPublicCarrier.mockResolvedValue(CARRIER);
  m.requireAdmin.mockResolvedValue({ userId: '11111111-1111-4111-8111-111111111111', role: 'admin' });
});

describe('реестр: публичен только приём отзыва', () => {
  it('POST отзыва и проверки ссылки — без JWT; чтение и выдача ссылки — за входом', () => {
    expect(isPublicApiPath('/api/carrier-reviews', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/carrier-reviews/invite', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/carrier-reviews', 'GET')).toBe(false);
    expect(isPublicApiPath('/api/admin/carrier-reviews/invites', 'POST')).toBe(false);
  });
});

describe('POST /api/carrier-reviews', () => {
  const linkBody = (over: Record<string, unknown> = {}) => ({ via: 'link', carrier: 'shatun', key: KEY, author_name: 'Ирина  Смирнова', rating: 5, comment: ' Хорошо ', ...over });

  it('без ссылки — отказ; анонимного отзыва и пути «место в поездке» нет', async () => {
    const res = await postReview(req('/api/carrier-reviews', { method: 'POST', body: { carrier: 'shatun', rating: 5, comment: 'x', author_name: 'Аноним' } }));
    expect(res.status).toBe(400);
    const seat = await postReview(req('/api/carrier-reviews', { method: 'POST', body: { via: 'seat', carrier: 'shatun', seat_booking_id: '22222222-2222-4222-8222-222222222222', rating: 5 } }));
    expect(seat.status).toBe(400);
    expect((await seat.json()).error).toContain('по ссылке');
    expect(m.writeInviteReview).not.toHaveBeenCalled();
  });

  it('по ссылке: подпись приведена, оценка и текст — как есть', async () => {
    m.writeInviteReview.mockResolvedValue({ ok: true, id: '7' });
    const res = await postReview(req('/api/carrier-reviews', { method: 'POST', body: linkBody() }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('Отзыв опубликован');
    expect(m.writeInviteReview).toHaveBeenCalledWith({ partnerId: 'p-1', key: KEY, authorName: 'Ирина Смирнова', rating: 5, comment: 'Хорошо' });
  });

  it('подпись с телефоном — отказ с полем, ничего не записано', async () => {
    const res = await postReview(req('/api/carrier-reviews', { method: 'POST', body: linkBody({ author_name: 'Ирина +79991234567' }) }));
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.field).toBe('author_name');
    expect(b.error).toContain('без телефона и почты');
    expect(m.writeInviteReview).not.toHaveBeenCalled();
  });

  it('ссылка использована / устарела / не найдена — словами и честным кодом', async () => {
    m.writeInviteReview.mockResolvedValueOnce({ ok: false, reason: 'used' });
    let res = await postReview(req('/api/carrier-reviews', { method: 'POST', body: linkBody() }));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toContain('отзыв уже оставлен');
    m.writeInviteReview.mockResolvedValueOnce({ ok: false, reason: 'expired' });
    res = await postReview(req('/api/carrier-reviews', { method: 'POST', body: linkBody() }));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toContain('Ссылка устарела');
    m.writeInviteReview.mockResolvedValueOnce({ ok: false, reason: 'unknown' });
    res = await postReview(req('/api/carrier-reviews', { method: 'POST', body: linkBody() }));
    expect(res.status).toBe(404);
  });

  it('ключ не той формы — отказ до базы', async () => {
    const res = await postReview(req('/api/carrier-reviews', { method: 'POST', body: linkBody({ key: 'short' }) }));
    expect(res.status).toBe(400);
    expect(m.findPublicCarrier).not.toHaveBeenCalled();
  });

  it('нет перевозчика — 404; отказ базы — 503 и SQLSTATE в логе', async () => {
    m.findPublicCarrier.mockResolvedValueOnce(null);
    expect((await postReview(req('/api/carrier-reviews', { method: 'POST', body: linkBody() }))).status).toBe(404);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.writeInviteReview.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '23514' }));
    const res = await postReview(req('/api/carrier-reviews', { method: 'POST', body: linkBody() }));
    expect(res.status).toBe(503);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('sqlstate=23514'), expect.any(String));
    err.mockRestore();
  });
});

describe('POST /api/carrier-reviews/invite — что за поездка по ссылке', () => {
  it('годная — направление и даты; негодная — словами', async () => {
    m.checkInvite.mockResolvedValueOnce({ state: 'ok', destination: 'Вулкан Горелый', dateFrom: '2026-10-12', dateTo: null });
    let res = await postInviteCheck(req('/api/carrier-reviews/invite', { method: 'POST', body: { carrier: 'shatun', key: KEY } }));
    expect((await res.json()).data).toEqual({ state: 'ok', destination: 'Вулкан Горелый', date_from: '2026-10-12', date_to: null });
    expect(m.checkInvite).toHaveBeenCalledWith('p-1', KEY);
    m.checkInvite.mockResolvedValueOnce({ state: 'expired' });
    res = await postInviteCheck(req('/api/carrier-reviews/invite', { method: 'POST', body: { carrier: 'shatun', key: KEY } }));
    const b = await res.json();
    expect(b.data.state).toBe('expired');
    expect(b.data.message).toContain('Ссылка устарела');
  });
});

describe('ссылку выдаёт менеджер, подтвердив поездку', () => {
  const LEAD = '33333333-3333-4333-8333-333333333333';
  it('только администратор', async () => {
    m.requireAdmin.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 403 }));
    expect((await postIssue(req('/api/admin/carrier-reviews/invites', { method: 'POST', body: { lead_id: LEAD } }))).status).toBe(403);
    expect(m.issueCharterInvite).not.toHaveBeenCalled();
  });
  it('поездка впереди — 409 словами; выдана — ключ во фрагменте адреса страницы отзыва', async () => {
    m.issueCharterInvite.mockResolvedValueOnce({ ok: false, reason: 'not_yet' });
    const early = await postIssue(req('/api/admin/carrier-reviews/invites', { method: 'POST', body: { lead_id: LEAD } }));
    expect(early.status).toBe(409);
    expect((await early.json()).error).toContain('Поездка ещё впереди');
    m.issueCharterInvite.mockResolvedValueOnce({ ok: true, key: KEY, slug: 'shatun', expiresAt: '2026-11-13T00:00:00.000Z' });
    const res = await postIssue(req('/api/admin/carrier-reviews/invites', { method: 'POST', body: { lead_id: LEAD } }));
    const url = new URL((await res.json()).data.url);
    expect(url.pathname).toBe('/transfers/shatun/review');
    expect(url.hash).toBe(`#${KEY}`);
    expect(url.search).toBe('');
    expect(m.issueCharterInvite).toHaveBeenLastCalledWith({ leadId: LEAD, confirmedBy: '11111111-1111-4111-8111-111111111111', today: kamchatkaToday() });
  });
});

describe('модерация', () => {
  it('скрыть — причина не короче 8; нет отзыва — 404', async () => {
    const short = await patchReview(req('/api/admin/carrier-reviews/5', { method: 'PATCH', body: { hidden: true, reason: 'плохо' } }), { params: Promise.resolve({ id: '5' }) });
    expect(short.status).toBe(400);
    expect(m.setCarrierReviewHidden).not.toHaveBeenCalled();
    m.setCarrierReviewHidden.mockResolvedValueOnce({ id: '5' });
    const ok = await patchReview(req('/api/admin/carrier-reviews/5', { method: 'PATCH', body: { hidden: true, reason: 'оскорбление водителя' } }), { params: Promise.resolve({ id: '5' }) });
    expect(ok.status).toBe(200);
    expect(m.setCarrierReviewHidden).toHaveBeenCalledWith('5', true, 'оскорбление водителя');
    m.setCarrierReviewHidden.mockResolvedValueOnce(null);
    const gone = await patchReview(req('/api/admin/carrier-reviews/9', { method: 'PATCH', body: { hidden: false } }), { params: Promise.resolve({ id: '9' }) });
    expect(gone.status).toBe(404);
  });

  it('экран менеджера: кнопка — по тому же правилу, что выдача; отказ одной части не прячет другую', async () => {
    const today = kamchatkaToday();
    const lead = (id: string, date_from: string | null, review_id: string | null = null) => ({
      lead_id: id, carrier_name: 'Шатун', carrier_slug: 'shatun', customer_name: 'Ирина', customer_phone: '+7999',
      destination: 'Горелый', date_from, date_to: null, passengers: '4', created_at: '2026-10-01', is_self: false,
      ride_confirmed_at: null, link_issued_at: null, link_expires_at: null, review_id,
    });
    m.listCharterLeadsForAdmin.mockResolvedValue([lead('a', today), lead('b', '2999-01-01'), lead('c', null), lead('d', today, '9')]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.listCarrierReviewsForAdmin.mockRejectedValue(Object.assign(new Error('x'), { code: '42P01' }));
    const res = await getAdmin(req('/api/admin/carrier-reviews'));
    const d = (await res.json()).data;
    expect(d.reviews).toEqual({ state: 'failed' });
    expect(d.charters.items.map((l: { issue: unknown }) => l.issue)).toEqual([
      { ok: true }, { ok: false, reason: 'not_yet' }, { ok: false, reason: 'no_date' }, { ok: false, reason: 'already_reviewed' },
    ]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('sqlstate=42P01'), expect.any(String));
    err.mockRestore();
  });
});

describe('публичный блок читает только видимые', () => {
  it('и список, и сводка — с is_hidden = FALSE; имя — «Имя Ф.»; средняя — один знак', async () => {
    m.dbQuery
      .mockResolvedValueOnce({ rows: [{ id: '1', author_name: 'Анна Петрова', rating: 5, comment: 'Ок', created_at: '2026-10-13', proof: 'seat', ride_date: '2026-10-12', ride_from: 'А', ride_to: 'Б' }] })
      .mockResolvedValueOnce({ rows: [{ n: 3, avg: '4.6666667' }] });
    const blk = await loadCarrierReviews('p-1');
    expect(blk).toMatchObject({ state: 'ok', count: 3, average: 4.7 });
    if (blk.state === 'ok') expect(blk.items[0]!.authorName).toBe('Анна П.');
    for (const [sql, params] of m.dbQuery.mock.calls) {
      expect(String(sql)).toMatch(/partner_id = \$1 AND is_hidden = FALSE/);
      expect((params as unknown[])[0]).toBe('p-1');
    }
  });
  it('отказ базы — «не смогли», а не пустой список', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.dbQuery.mockRejectedValue(Object.assign(new Error('x'), { code: '57P01' }));
    expect(await loadCarrierReviews('p-1')).toEqual({ state: 'failed' });
    err.mockRestore();
  });
});
