// @vitest-environment node
/**
 * Голосование группы (фича 6): ссылка — у владельца, голос — без входа.
 * БД подменена: проверяются правила маршрутов, а не SQL на проде.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { query, auth } = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
vi.mock('@/lib/auth/middleware', () => ({ requireAuth: auth }));

const owner = await import('@/app/api/trips/[id]/vote-link/route');
const pub = await import('@/app/api/trip-vote/[token]/route');
const { hashToken, voterKey, MAX_VOTERS } = await import('@/lib/trips/trip-vote');
const { isPublicApiPath } = await import('@/lib/auth/public-api-routes');

const TRIP = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'A'.repeat(32);
const LINK = { id: 'link-1', deadline_at: new Date(Date.now() + 3_600_000).toISOString(), title: 'Камчатка', arrival_date: '2026-12-01',
  days: [{ day: 1, title: 'Прилёт' }, { day: 2, title: 'Рыбалка' }] };
let ip = 0;
const req = (url: string, method: string, body?: unknown, cookie?: string) => new NextRequest(`https://vedarai.ru${url}`, {
  method, headers: { 'content-type': 'application/json', 'x-real-ip': `10.9.0.${++ip}`, ...(cookie ? { cookie } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const tokenCtx = (token = TOKEN) => ({ params: Promise.resolve({ token }) });
const tripCtx = { params: Promise.resolve({ id: TRIP }) };

beforeEach(() => { query.mockReset(); auth.mockReset(); });

describe('владелец: ссылка голосования', () => {
  it('без входа — ответ requireAuth, БД не зовётся', async () => {
    auth.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 401 }));
    expect((await owner.POST(req(`/api/trips/${TRIP}/vote-link`, 'POST', { hours: 48 }), tripCtx)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(isPublicApiPath(`/api/trips/${TRIP}/vote-link`, 'POST')).toBe(false);
  });
  it('чужая поездка — 404', async () => {
    auth.mockResolvedValueOnce({ userId: 'u2' });
    query.mockResolvedValueOnce({ rows: [] });
    expect((await owner.POST(req(`/api/trips/${TRIP}/vote-link`, 'POST', { hours: 48 }), tripCtx)).status).toBe(404);
  });
  it('новая ссылка: токен — один раз в ответе, в БД — только хэш, прежняя закрыта', async () => {
    auth.mockResolvedValueOnce({ userId: 'u1' });
    query.mockResolvedValueOnce({ rows: [{ days: LINK.days }] }).mockResolvedValue({ rows: [] });
    const res = await owner.POST(req(`/api/trips/${TRIP}/vote-link`, 'POST', { hours: 48 }), tripCtx);
    const data = (await res.json()).data as { path: string };
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const token = data.path.replace('/vote/', '');
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(query.mock.calls[1][0]).toContain('SET closed_at = NOW()');
    const insert = query.mock.calls[2];
    expect(insert[1]).toContain(hashToken(token));
    expect(JSON.stringify(insert[1])).not.toContain(token);
  });
});

describe('голос без входа', () => {
  it('адрес открыт Edge-у без входа', () => {
    expect(isPublicApiPath(`/api/trip-vote/${TOKEN}`, 'POST')).toBe(true);
    expect(isPublicApiPath(`/api/trip-vote/${TOKEN}`, 'GET')).toBe(true);
  });
  it('кривой токен — 404 без запроса в БД', async () => {
    expect((await pub.GET(req('/api/trip-vote/x', 'GET'), tokenCtx('x'))).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });
  it('первый голос: cookie голосующего ставится, в БД — хэш, наружу нет владельца и туров', async () => {
    query.mockResolvedValueOnce({ rows: [LINK] })
      .mockResolvedValueOnce({ rows: [{ n: 0, me: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ day_num: 2, vote: -1, voter_key: 'k' }] });
    const res = await pub.POST(req(`/api/trip-vote/${TOKEN}`, 'POST', { day: 2, vote: -1 }), tokenCtx());
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/trip_voter=[0-9a-f]{32}/);
    expect(cookie).toMatch(/HttpOnly/i);
    const voter = /trip_voter=([0-9a-f]{32})/.exec(cookie)![1];
    expect(query.mock.calls[0][1]).toEqual([hashToken(TOKEN)]);
    expect(query.mock.calls[2][1]).toEqual(['link-1', 2, voterKey('link-1', voter), -1]);
    const body = await res.json();
    expect(body.data.tallies).toEqual([{ day: 2, up: 0, down: 1 }]);
    expect(JSON.stringify(body)).not.toMatch(/user_id|tourId|operator/);
  });
  it('срок вышел — 409, голос не пишется', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...LINK, deadline_at: new Date(Date.now() - 1000).toISOString() }] });
    expect((await pub.POST(req(`/api/trip-vote/${TOKEN}`, 'POST', { day: 1, vote: 1 }), tokenCtx())).status).toBe(409);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it(`потолок ${MAX_VOTERS} голосующих — новый не принимается, прежний может переголосовать`, async () => {
    query.mockResolvedValueOnce({ rows: [LINK] }).mockResolvedValueOnce({ rows: [{ n: MAX_VOTERS, me: false }] });
    expect((await pub.POST(req(`/api/trip-vote/${TOKEN}`, 'POST', { day: 1, vote: 1 }), tokenCtx())).status).toBe(409);
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [LINK] }).mockResolvedValueOnce({ rows: [{ n: MAX_VOTERS, me: true }] }).mockResolvedValue({ rows: [] });
    const res = await pub.POST(req(`/api/trip-vote/${TOKEN}`, 'POST', { day: 1, vote: 1 }, `trip_voter=${'a'.repeat(32)}`), tokenCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
  it('дня нет в поездке — 400', async () => {
    query.mockResolvedValueOnce({ rows: [LINK] });
    expect((await pub.POST(req(`/api/trip-vote/${TOKEN}`, 'POST', { day: 7, vote: 1 }), tokenCtx())).status).toBe(400);
  });
  it('голос 0 — снять свой голос', async () => {
    query.mockResolvedValueOnce({ rows: [LINK] }).mockResolvedValue({ rows: [] });
    await pub.POST(req(`/api/trip-vote/${TOKEN}`, 'POST', { day: 1, vote: 0 }, `trip_voter=${'b'.repeat(32)}`), tokenCtx());
    expect(query.mock.calls[1][0]).toContain('DELETE FROM trip_votes');
  });
});
