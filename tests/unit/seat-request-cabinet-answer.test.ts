/**
 * Сторож ответа на запрос мест из «Входящих» кабинета (CRM, хвосты фазы 1).
 *
 * Держит:
 *  - дверь третья, функция та же: роут зовёт answerSeatRequest и своего
 *    UPDATE не имеет — атомарный захват, срок 2 часа и бронь при «есть
 *    места» остаются в одном месте;
 *  - право: вход в кабинет оператора (requirePartner, категория operator) и
 *    запрос, адресованный ему (operator_id в SQL); чужой — 404, как
 *    несуществующий, и до ответа дело не доходит; база молчит — 503;
 *  - контактов туриста роут не читает: они приходят уведомлением о брони
 *    только после «есть места» (решение 29.09). Шире: ни один роут кабинета
 *    под app/api/hub не берёт tourist_name/tourist_phone из запросов мест —
 *    до этого сторожа защита держалась только на том, что такого роута нет;
 *  - кнопки ответа стоят у запроса мест во «Входящих».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { NextRequest, NextResponse } from 'next/server';

const requirePartner = vi.fn();
const requestBelongsToPartner = vi.fn();
const answerSeatRequest = vi.fn();
vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: (...a: unknown[]) => requirePartner(...a) }));
vi.mock('@/lib/seat-requests/service', () => ({
  requestBelongsToPartner: (...a: unknown[]) => requestBelongsToPartner(...a),
  answerSeatRequest: (...a: unknown[]) => answerSeatRequest(...a),
}));

const { POST } = await import('@/app/api/hub/crm/seat-requests/[id]/answer/route');

const ROUTE = 'app/api/hub/crm/seat-requests/[id]/answer/route.ts';
const RID = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const OP = { outcome: 'ok', partnerId: 'p-op', category: 'operator', userId: 'u-1' };

const req = (body: unknown) => new NextRequest(`http://localhost/api/hub/crm/seat-requests/${RID}/answer`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const call = (body: unknown, id = RID) => POST(req(body), { params: Promise.resolve({ id }) });

beforeEach(() => {
  requirePartner.mockReset();
  requestBelongsToPartner.mockReset();
  answerSeatRequest.mockReset();
});

describe('право ответить', () => {
  it('гард не пустил — его ответ, до запроса дело не доходит', async () => {
    requirePartner.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 401 }));
    expect((await call({ answer: 'yes' })).status).toBe(401);
    expect(requestBelongsToPartner).not.toHaveBeenCalled();
  });

  it('не оператор — 403: запросы мест получают операторы туров', async () => {
    requirePartner.mockResolvedValueOnce({ ...OP, category: 'guide' });
    expect((await call({ answer: 'yes' })).status).toBe(403);
    expect(answerSeatRequest).not.toHaveBeenCalled();
  });

  it('чужой запрос — 404 и без ответа; база молчит — 503', async () => {
    requirePartner.mockResolvedValue(OP);
    requestBelongsToPartner.mockResolvedValueOnce(false);
    expect((await call({ answer: 'yes' })).status).toBe(404);
    requestBelongsToPartner.mockResolvedValueOnce('db_error');
    expect((await call({ answer: 'yes' })).status).toBe(503);
    expect(answerSeatRequest).not.toHaveBeenCalled();
    expect(requestBelongsToPartner).toHaveBeenCalledWith(RID, 'p-op');
  });

  it('битый id и «другая дата» без даты — отказ до базы', async () => {
    requirePartner.mockResolvedValue(OP);
    expect((await call({ answer: 'yes' }, 'nope')).status).toBe(404);
    expect((await call({ answer: 'other_date' })).status).toBe(400);
    expect((await call({ answer: 'maybe' })).status).toBe(400);
    expect(requestBelongsToPartner).not.toHaveBeenCalled();
  });
});

describe('ответ — та же функция, что у кнопки MAX и ссылки', () => {
  beforeEach(() => {
    requirePartner.mockResolvedValue(OP);
    requestBelongsToPartner.mockResolvedValue(true);
  });

  it('«есть места» уходит в answerSeatRequest; ответ — слова для оператора', async () => {
    answerSeatRequest.mockResolvedValueOnce({ ok: true, status: 'declined', tourTitle: 'Вулкан', date: '2030-07-01' });
    const r = await call({ answer: 'no' });
    expect(r.status).toBe(200);
    expect((await r.json()).data.message).toMatch(/мест на «Вулкан», 2030-07-01 нет/);
    expect(answerSeatRequest).toHaveBeenCalledWith(RID, { kind: 'no' }, 'web');
  });

  it('«другая дата» передаёт дату; принято без записанного исхода — 202, а не ошибка ввода', async () => {
    answerSeatRequest.mockResolvedValueOnce({ ok: false, reason: 'accepted_unfinished' });
    const r = await call({ answer: 'other_date', date: '2030-07-05' });
    expect(answerSeatRequest).toHaveBeenCalledWith(RID, { kind: 'other_date', date: '2030-07-05' }, 'web');
    expect(r.status).toBe(202);
    expect((await r.json()).reason).toBe('accepted_unfinished');
  });

  it('уже ответили — 409 со словами, срок вышел — 409', async () => {
    answerSeatRequest.mockResolvedValueOnce({ ok: false, reason: 'already_answered' });
    expect((await call({ answer: 'yes' })).status).toBe(409);
    answerSeatRequest.mockResolvedValueOnce({ ok: false, reason: 'expired' });
    const r = await call({ answer: 'yes' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Срок ответа/);
  });
});

describe('исходники', () => {
  const route = readFileSync(ROUTE, 'utf8');

  it('своего SQL у роута нет: захват, срок и бронь — в answerSeatRequest', () => {
    const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bSELECT\b|pool\.query|from '@\/lib\/db-pool'/);
    expect(route).toMatch(/await requestBelongsToPartner\(id\.data, ctx\.partnerId\)/);
    expect(route.indexOf('requestBelongsToPartner(id.data')).toBeLessThan(route.indexOf('await answerSeatRequest('));
  });

  it('принадлежность — operator_id в самом SQL', () => {
    const svc = readFileSync('lib/seat-requests/service.ts', 'utf8');
    expect(svc).toMatch(/FROM tour_seat_requests WHERE id = \$1::uuid AND operator_id = \$2::uuid/);
  });

  it('ни один роут кабинета не берёт контакты туриста из запросов мест', () => {
    const files = execSync("git ls-files 'app/api/hub'", { encoding: 'utf8' })
      .split('\n').filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (!/tour_seat_requests|@\/lib\/seat-requests\//.test(src)) continue;
      expect(src, f).not.toMatch(/tourist_name|tourist_phone/);
    }
    expect(files).toContain(ROUTE);
  });

  it('кнопки ответа стоят у запроса мест во «Входящих»', () => {
    const screen = readFileSync('components/crm/InboxScreen.tsx', 'utf8');
    expect(screen).toMatch(/item\.kind === 'seat_request' && <SeatRequestActions requestId=\{item\.id\}/);
    const actions = readFileSync('components/crm/SeatRequestActions.tsx', 'utf8');
    expect(actions).not.toMatch(/tourist|phone|телефон/i);
  });
});
