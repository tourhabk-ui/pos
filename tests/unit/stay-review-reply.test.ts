/**
 * Сторож ответа владельца жилья на отзыв гостя (CRM, хвосты фазы 1, #2325;
 * колонки — миграция 1208).
 *
 * Держит:
 *  - владение — в самом UPDATE (объект отзыва — партнёра владельца);
 *  - профиль не прочитался — 503, а не «отзыва нет»;
 *  - сохранённый ответ не превращается в 500 из-за уведомления гостю;
 *  - список отзывов отдаёт имя гостя «Имя Ф.» и не отдаёт почту;
 *  - экран и пункт меню есть, отзыв без ответа — во «Входящих» жилья;
 *  - на странице объекта под отзывом — ответ хозяина;
 *  - ответ пишут один компонент на оба кабинета.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';

const requireStayOwner = vi.fn();
const getStayPartnerId = vi.fn();
const query = vi.fn();
class StayCheckUnavailableError extends Error {}
vi.mock('@/lib/auth/stay-helpers', () => ({
  requireStayOwner: (...a: unknown[]) => requireStayOwner(...a),
  getStayPartnerId: (...a: unknown[]) => getStayPartnerId(...a),
  stayCheckUnavailableResponse: () => NextResponse.json({ success: false }, { status: 503 }),
  StayCheckUnavailableError,
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));

const reply = await import('@/app/api/stay/reviews/[id]/reply/route');
const list = await import('@/app/api/stay/reviews/route');

const RID = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const req = (method: string, body?: unknown) => new NextRequest(`http://localhost/api/stay/reviews/${RID}/reply`, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = (id = RID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireStayOwner.mockReset();
  getStayPartnerId.mockReset();
  query.mockReset();
  requireStayOwner.mockResolvedValue({ userId: 'u-stay', role: 'stay' });
  getStayPartnerId.mockResolvedValue('p-stay');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ответ на отзыв гостя', () => {
  it('владение — в самом UPDATE: объект отзыва — партнёра владельца', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: RID, user_id: null, owner_reply: 'Ждём снова', owner_reply_at: new Date() }] });
    const r = await reply.POST(req('POST', { reply: ' Ждём снова ' }), ctx());
    expect(r.status).toBe(200);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE accommodation_reviews r[\s\S]*r\.accommodation_id = a\.id AND a\.partner_id = \$2/);
    expect(params).toEqual([RID, 'p-stay', 'Ждём снова']);
    expect(query).toHaveBeenCalledTimes(1); // гостя без аккаунта уведомлять некому
  });

  it('не его отзыв — 404; профиль не прочитался — 503, а не «нет отзыва»', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await reply.POST(req('POST', { reply: 'x' }), ctx())).status).toBe(404);
    getStayPartnerId.mockRejectedValueOnce(new StayCheckUnavailableError('x'));
    expect((await reply.POST(req('POST', { reply: 'x' }), ctx())).status).toBe(503);
  });

  it('уведомление гостю не записалось — ответ сохранён, отказ в логе', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: RID, user_id: 'u-g', owner_reply: 'x', owner_reply_at: new Date() }] })
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: '23503' }));
    expect((await reply.POST(req('POST', { reply: 'x' }), ctx())).status).toBe(200);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/уведомление гостю не записано, SQLSTATE 23503/);
  });

  it('пустой, длинный ответ и битый id — до базы не доходят', async () => {
    expect((await reply.POST(req('POST', { reply: ' ' }), ctx())).status).toBe(400);
    expect((await reply.POST(req('POST', { reply: 'а'.repeat(2001) }), ctx())).status).toBe(400);
    expect((await reply.POST(req('POST', { reply: 'x' }), ctx('nope'))).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('удалить ответ — тем же предикатом владения', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    expect((await reply.DELETE(req('DELETE'), ctx())).status).toBe(200);
    expect(query.mock.calls[0][0]).toMatch(/a\.partner_id = \$2 AND r\.owner_reply IS NOT NULL/);
  });

  it('гард роли не пустил — его ответ', async () => {
    requireStayOwner.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 403 }));
    expect((await reply.POST(req('POST', { reply: 'x' }), ctx())).status).toBe(403);
  });
});

describe('список отзывов владельца', () => {
  it('скоуп — партнёр владельца; имя гостя «Имя Ф.», почты нет', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: RID, accommodation_name: 'Дом у реки', user_name: 'Анна Петрова', rating: 5, title: null, comment: 'Отлично',
      is_visible: true, owner_reply: null, created_at: new Date('2026-10-01T00:00:00Z'),
    }] });
    const r = await list.GET(new NextRequest('http://localhost/api/stay/reviews'));
    const body = await r.json();
    expect(body.data.reviews[0]).toMatchObject({ userName: 'Анна П.', accommodationName: 'Дом у реки', isVisible: true });
    expect(JSON.stringify(body)).not.toMatch(/Петрова|@/);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE a\.partner_id = \$1/);
    expect(sql).not.toMatch(/email/);
    expect(params[0]).toBe('p-stay');
  });
});

describe('экран, «Входящие», страница объекта', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('экран и пункт меню жилья; ответ пишет общий компонент обоих кабинетов', () => {
    const screen = read('app/hub/stay/reviews/_StayReviewsClient.tsx');
    expect(screen).toMatch(/fetch\('\/api\/stay\/reviews'/);
    expect(screen).toMatch(/<ReviewReplyBox endpoint=\{`\/api\/stay\/reviews\/\$\{encodeURIComponent\(r\.id\)\}\/reply`\}/);
    expect(read('app/hub/operator/reviews/_OperatorReviewsClient.tsx')).toMatch(/<ReviewReplyBox /);
    expect(read('app/hub/stay/reviews/page.tsx')).toMatch(/robots: 'noindex, nofollow'/);
    expect(read('app/hub/stay/layout.tsx')).toMatch(/href: '\/hub\/stay\/reviews',\s+label: 'Отзывы'/);
  });

  it('отзыв гостя без ответа — во «Входящих» жилья, и больше не в «чего здесь нет»', async () => {
    const kinds = await import('@/lib/crm/inbox-kinds');
    expect(kinds.INBOX_BY_CATEGORY.stay).toContain('stay_review');
    expect(kinds.INBOX_ACTION.stay_review.href).toBe('/hub/stay/reviews');
    expect(kinds.RESPONSE_METRIC_KINDS.has('stay_review')).toBe(false);
    expect(kinds.INBOX_NOT_HERE.stay).toEqual([]);
    const { INBOX_SQL } = await import('@/lib/crm/inbox-sql');
    expect(INBOX_SQL.stay_review).toMatch(/a\.partner_id = \$1/);
    expect(INBOX_SQL.stay_review).not.toMatch(/user_id|u\.name/);
  });

  it('на странице объекта под отзывом — ответ хозяина', () => {
    expect(read('lib/stay/accommodation-detail.ts')).toMatch(/ownerReply: review\.owner_reply/);
    expect(read('app/accommodations/[id]/_AccommodationDetailClient.tsx')).toMatch(/review\.ownerReply && \(/);
  });

  it('в миграции ответ и его время держатся парой', () => {
    const sql = read('migrations/1208_accommodation_review_owner_reply.sql');
    expect(sql).toMatch(/CHECK \(\(owner_reply IS NULL\) = \(owner_reply_at IS NULL\)\)/);
  });
});
