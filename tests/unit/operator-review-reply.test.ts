/**
 * Сторож ответа оператора на отзыв о туре (CRM, хвосты фазы 1, #2325).
 *
 * Роуты были, экрана не было, и во «Входящих» отзыв числился «ответить
 * нельзя». Держит:
 *  - владение — в самом UPDATE (тур отзыва — партнёра вошедшего оператора);
 *  - сохранённый ответ не превращается в 500 из-за уведомления: у отзыва
 *    без аккаунта уведомления нет, отказ записи уведомления — в лог;
 *  - отказ базы — 503 со SQLSTATE в логе, а не немой 500;
 *  - экран и пункт меню есть, отзыв без ответа — во «Входящих» оператора;
 *  - на карточке тура под отзывом виден ответ, а автор — «Имя Ф.» (как у
 *    отзывов о жилье и маршрутах), и так же в публичном API отзывов.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';

const requireOperator = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({ requireOperator: (...a: unknown[]) => requireOperator(...a) }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));

const { POST, DELETE } = await import('@/app/api/operator/reviews/[id]/reply/route');

const OP = { userId: 'u-op', role: 'operator' };
const req = (body?: unknown) => new NextRequest('http://localhost/api/operator/reviews/7/reply', {
  method: body === undefined ? 'DELETE' : 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = (id = '7') => ({ params: Promise.resolve({ id }) });
const savedRow = (over: Record<string, unknown> = {}) => ({
  id: 7, user_id: 'u-tourist', operator_reply: 'Спасибо!', operator_reply_at: new Date('2026-10-10T00:00:00Z'), ...over,
});

beforeEach(() => {
  requireOperator.mockReset();
  query.mockReset();
  requireOperator.mockResolvedValue(OP);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ответ на отзыв', () => {
  it('гард не пустил — его ответ, база не тронута', async () => {
    requireOperator.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 403 }));
    expect((await POST(req({ reply: 'x' }), ctx())).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('владение — в самом UPDATE: тур отзыва принадлежит партнёру вошедшего', async () => {
    query.mockResolvedValueOnce({ rows: [savedRow()] }).mockResolvedValueOnce({ rows: [] });
    expect((await POST(req({ reply: '  Спасибо!  ' }), ctx())).status).toBe(200);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE operator_tour_reviews r[\s\S]*r\.tour_id = t\.id AND t\.operator_id = p\.id AND p\.user_id = \$2/);
    expect(params).toEqual([7, 'u-op', 'Спасибо!']);
  });

  it('не его отзыв — 404, и уведомления нет', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await POST(req({ reply: 'x' }), ctx())).status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('отзыв без аккаунта — ответ сохранён, уведомлять некого', async () => {
    query.mockResolvedValueOnce({ rows: [savedRow({ user_id: null })] });
    const r = await POST(req({ reply: 'Спасибо!' }), ctx());
    expect(r.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('уведомление не записалось — ответ всё равно сохранён, отказ в логе', async () => {
    query.mockResolvedValueOnce({ rows: [savedRow()] }).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '23503' }));
    const r = await POST(req({ reply: 'Спасибо!' }), ctx());
    expect(r.status).toBe(200);
    expect((await r.json()).data.operatorReply).toBe('Спасибо!');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/уведомление автору не записано, SQLSTATE 23503/);
  });

  it('база не ответила — 503 со SQLSTATE в логе; пустой и длинный ответ — 400 до базы', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '08006' }));
    expect((await POST(req({ reply: 'x' }), ctx())).status).toBe(503);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/SQLSTATE 08006/);
    query.mockReset();
    expect((await POST(req({ reply: '   ' }), ctx())).status).toBe(400);
    expect((await POST(req({ reply: 'а'.repeat(2001) }), ctx())).status).toBe(400);
    expect((await POST(req({ reply: 'x' }), ctx('abc'))).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('удалить ответ — тем же предикатом владения; нечего удалять — 404', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    expect((await DELETE(req(), ctx())).status).toBe(200);
    expect(query.mock.calls[0][0]).toMatch(/p\.user_id = \$2[\s\S]*operator_reply IS NOT NULL/);
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect((await DELETE(req(), ctx())).status).toBe(404);
  });
});

describe('экран, «Входящие», карточка', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('экран отзывов зовёт роуты и стоит в меню оператора', () => {
    const screen = read('app/hub/operator/reviews/_OperatorReviewsClient.tsx');
    expect(screen).toMatch(/fetch\('\/api\/operator\/reviews\?limit=50'/);
    expect(screen).toMatch(/<ReviewReplyBox endpoint=\{`\/api\/operator\/reviews\/\$\{r\.id\}\/reply`\}/);
    expect(read('app/hub/operator/reviews/page.tsx')).toMatch(/robots: 'noindex, nofollow'/);
    expect(read('app/hub/operator/layout.tsx')).toMatch(/href: '\/hub\/operator\/reviews', label: 'Отзывы'/);
  });

  it('отзыв о туре без ответа — во «Входящих» оператора, и больше не в «чего здесь нет»', async () => {
    const kinds = await import('@/lib/crm/inbox-kinds');
    expect(kinds.INBOX_BY_CATEGORY.operator).toContain('tour_review');
    expect(kinds.INBOX_ACTION.tour_review.href).toBe('/hub/operator/reviews');
    expect(kinds.RESPONSE_METRIC_KINDS.has('tour_review')).toBe(false);
    expect(kinds.INBOX_NOT_HERE.operator.join(' ')).not.toMatch(/Отзывы на туры/);
    const { INBOX_SQL } = await import('@/lib/crm/inbox-sql');
    expect(INBOX_SQL.tour_review).toMatch(/t\.operator_id = \$1/);
    expect(INBOX_SQL.tour_review).toMatch(/r\.is_hidden = FALSE/);
    expect(INBOX_SQL.tour_review).not.toMatch(/author_name|user_id/);
  });

  it('на карточке тура под отзывом — ответ оператора; автор — «Имя Ф.»', () => {
    const q = read('lib/tours/tour-detail-query.ts');
    expect(q).toMatch(/trip_date, operator_reply/);
    expect(q).toMatch(/author_name: publicReviewerName\(r\.author_name\)/);
    expect(read('app/catalog/tours/[id]/_TourDetailClient.tsx')).toMatch(/r\.operator_reply && \(/);
    expect(read('app/api/reviews/tour/[tourId]/route.ts')).toMatch(/author_name: publicReviewerName\(r\.author_name\)/);
  });
});
