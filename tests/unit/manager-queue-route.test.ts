/**
 * Дверь очереди менеджера — `/api/admin/manager-queue` (этап 3б).
 *
 * Очередь отдаёт имя и телефон клиента, а отметка «Взял» говорит второму
 * менеджеру, что случаем занимаются. Судится вызовом роута:
 *  - не администратор не получает ни списка, ни отметки — и до очереди дело
 *    не доходит;
 *  - кто взял — из входа администратора, а не из тела запроса;
 *  - исходы отметки названы разными ответами: взял, уже взят, случая в очереди
 *    нет (409), не записано (503) — отказ базы не выдаётся ни за «взял», ни за
 *    «случая нет» (§4.0);
 *  - чужая форма рода, номера и действия отклоняется до базы.
 * Само правило очереди — tests/unit/manager-queue.test.tsx, запросы на
 * настоящем PostgreSQL — tests/integration/request-chat.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const h = vi.hoisted(() => ({ auth: vi.fn(), load: vi.fn(), take: vi.fn(), release: vi.fn() }));

vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn(async () => { throw new Error('дверь в базу сама не ходит'); }) },
}));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => h.auth(...a) }));
vi.mock('@/lib/manager-queue/queue', async (orig) => ({
  ...(await orig<typeof import('@/lib/manager-queue/queue')>()),
  loadManagerQueue: (...a: unknown[]) => h.load(...a),
  takeQueueItem: (...a: unknown[]) => h.take(...a),
  releaseQueueItem: (...a: unknown[]) => h.release(...a),
}));

import { GET, POST } from '@/app/api/admin/manager-queue/route';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const STAY = '22222222-2222-4222-8222-222222222222';
const QUEUE = {
  since: '2026-11-12',
  answer_notice: { state: 'ok', items: [{ kind: 'answer_notice', id: '101', contact_name: 'Анна', contact_phone: '+79990000001' }], more: false },
  vehicle_decline: { state: 'failed' },
  stay_busy: { state: 'ok', items: [], more: false },
};

const get = () => GET(new NextRequest('http://localhost/api/admin/manager-queue'));
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/admin/manager-queue', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
}));

beforeEach(() => {
  for (const f of [h.auth, h.load, h.take, h.release]) f.mockReset();
  h.auth.mockResolvedValue({ userId: ADMIN, role: 'admin', email: 'admin@example.com' });
  h.load.mockResolvedValue(QUEUE);
  h.take.mockResolvedValue({ kind: 'taken', at: '2026-11-12T07:00:00.000Z' });
  h.release.mockResolvedValue({ kind: 'released' });
});

describe('кто входит', () => {
  it('не администратор: ни списка с телефонами, ни отметки — очередь не читается и не пишется', async () => {
    for (const status of [401, 403]) {
      h.auth.mockResolvedValue(NextResponse.json({ success: false, error: 'нет доступа' }, { status }));
      const list = await get();
      expect(list.status).toBe(status);
      expect(JSON.stringify(await list.json())).not.toMatch(/Анна|79990000001/);
      expect((await post({ kind: 'answer_notice', id: '101', action: 'take' })).status).toBe(status);
      expect((await post({ kind: 'answer_notice', id: '101', action: 'release' })).status).toBe(status);
    }
    expect(h.load).not.toHaveBeenCalled();
    expect(h.take).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('администратор получает три источника как они прочитаны — сбой остаётся сбоем', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: QUEUE });
  });

  it('вход без аккаунта человека отметку не ставит и не снимает', async () => {
    for (const userId of ['cron', '', undefined, 42]) {
      h.auth.mockResolvedValue({ userId, role: 'admin', email: '' });
      for (const action of ['take', 'release']) {
        const res = await post({ kind: 'answer_notice', id: '101', action });
        expect(res.status, `${String(userId)} ${action}`).toBe(403);
        expect((await res.json()).error).toBe('Отметку «взял» ставит и снимает администратор со своим входом');
      }
    }
    expect(h.take).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe('«Взял»', () => {
  it('кто взял — из входа, а не из тела запроса; дверь — сайт', async () => {
    const res = await post({ kind: 'stay_busy', id: STAY, action: 'take', userId: '99999999-9999-4999-8999-999999999999', via: 'max' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, outcome: 'taken', take: { kind: 'taken', at: '2026-11-12T07:00:00.000Z' } });
    expect(h.take).toHaveBeenCalledTimes(1);
    expect(h.take).toHaveBeenCalledWith({ kind: 'stay_busy', id: STAY, userId: ADMIN, via: 'site' });
  });

  it('исходы названы разными ответами', async () => {
    h.take.mockResolvedValue({ kind: 'already', at: '2026-11-12T06:30:00.000Z', by: 'Ирина', mine: false });
    const already = await post({ kind: 'answer_notice', id: '101', action: 'take' });
    expect(already.status).toBe(200);
    expect(await already.json()).toMatchObject({ success: true, outcome: 'already', take: { by: 'Ирина', mine: false } });

    h.take.mockResolvedValue({ kind: 'not_in_queue' });
    const gone = await post({ kind: 'answer_notice', id: '101', action: 'take' });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({
      success: false, outcome: 'not_in_queue',
      error: 'Этого случая в очереди уже нет: сообщение дошло или заявка изменилась. Обновите список.',
    });

    h.take.mockResolvedValue({ kind: 'failed' });
    const failed = await post({ kind: 'answer_notice', id: '101', action: 'take' });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ success: false, error: 'Не удалось записать отметку — попробуйте ещё раз' });
  });

  it('«Вернуть в очередь»: снята, уже не было, не снята', async () => {
    const ok = await post({ kind: 'vehicle_decline', id: '51', action: 'release' });
    expect(await ok.json()).toEqual({ success: true, outcome: 'released' });
    expect(h.release).toHaveBeenCalledWith({ kind: 'vehicle_decline', id: '51' });
    expect(h.take).not.toHaveBeenCalled();

    h.release.mockResolvedValue({ kind: 'not_taken' });
    expect(await (await post({ kind: 'vehicle_decline', id: '51', action: 'release' })).json()).toEqual({ success: true, outcome: 'not_taken' });

    h.release.mockResolvedValue({ kind: 'failed' });
    const failed = await post({ kind: 'vehicle_decline', id: '51', action: 'release' });
    expect(failed.status).toBe(503);
    expect((await failed.json()).success).toBe(false);
  });
});

describe('чужая форма отклоняется до очереди', () => {
  it('род, номер и действие', async () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ kind: 'lead', id: '101', action: 'take' }, /Род случая не распознан/],
      [{ kind: 'answer_notice', id: '101', action: 'done' }, /take или release/],
      [{ kind: 'answer_notice', id: 'abc', action: 'take' }, /Номер случая не распознан/],
      [{ kind: 'stay_busy', id: '101', action: 'take' }, /Номер случая не распознан/],
      [{ kind: 'vehicle_decline', id: STAY, action: 'release' }, /Номер случая не распознан/],
      [{ kind: 'answer_notice', action: 'take' }, /./],
      ['не json', /./],
    ];
    for (const [body, error] of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toMatch(error);
    }
    expect(h.take).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});
