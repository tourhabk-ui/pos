/**
 * Лента бюллетеней VONA не прочиталась — прогон kvert-acc красный (#2315, 09.10).
 *
 * Синк пишет недельную сводку KVERT и поверх неё — бюллетени, вышедшие после
 * неё. Отказ ленты синк не роняет (сводка всё равно записывается) и кладёт
 * причину в `vona.error`. До 09.10 это поле не читал никто: прогон отвечал
 * 200, история писала success, и код Шивелуча «от 02.10» через шесть дней
 * нельзя было отличить ни от «KVERT молчит», ни от «мы не дочитали».
 *
 * Сводка при этом записана — проверяется, что тело ответа это говорит, а не
 * только что прогон красный.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const syncKvertAcc = vi.fn();
const recordCronRun = vi.fn();
vi.mock('@/lib/agents/kvert-sync', () => ({ syncKvertAcc: () => syncKvertAcc() }));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: (...a: unknown[]) => recordCronRun(...a) }));
vi.mock('@/lib/auth/cron', () => ({ getCronSecret: () => 's' }));

process.env.CRON_SECRET = 's';
const { GET } = await import('@/app/api/cron/kvert-acc/route');
const req = {} as NextRequest;

const OK = {
  fetched: 20, upserted: 20, matched: 18, unmatched: [], places_indexed: 40,
  vona: { latest: 170, read: 3, newer: 2, applied: ['shiveluch'], failed: [], truncated: false },
};

beforeEach(() => {
  syncKvertAcc.mockReset();
  recordCronRun.mockReset();
});

describe('kvert-acc: отказ ленты VONA', () => {
  it('лента не ответила — 502, failed в истории, и сказано, что сводка записана', async () => {
    syncKvertAcc.mockResolvedValueOnce({
      ...OK,
      vona: { latest: null, read: 0, newer: 0, applied: [], failed: [], error: 'лента VONA не ответила' },
    });
    const res = await GET(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('KVERT: сводка записана (18), лента бюллетеней VONA не прочитана — лента VONA не ответила');
    expect(recordCronRun).toHaveBeenCalledWith('kvert-acc', expect.any(Number), 'failed', { error: body.error });
  });

  it('отдельные недочитанные выпуски — не отказ: названы в теле, прогон зелёный', async () => {
    syncKvertAcc.mockResolvedValueOnce({ ...OK, vona: { ...OK.vona, failed: [168] } });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect((await res.json()).vona.failed).toEqual([168]);
    expect(recordCronRun).toHaveBeenCalledWith('kvert-acc', expect.any(Number), 'success', { items: 18 });
  });

  it('лента прочитана — успех считается сопоставленными, как раньше', async () => {
    syncKvertAcc.mockResolvedValueOnce(OK);
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(recordCronRun).toHaveBeenCalledWith('kvert-acc', expect.any(Number), 'success', { items: 18 });
  });
});
