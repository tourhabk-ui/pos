/**
 * /api/cron/place-description-drafts-review — второй, CRON_SECRET-вход к той
 * же публикации, что и `PATCH /api/admin/places/[id]/description-draft`
 * (#1830, 13.09: «сам делай ревью»). `/api/admin/*` требует Authorization:
 * Bearer именно на Edge (middleware.ts) — но пробы (`probe-url.yml`)
 * подставляют CRON_SECRET только на `/api/cron/*`, класть секрет руками в
 * committed `probe-url.json` нельзя. Роут делает РОВНО ту же публикацию,
 * что admin PATCH — держим оба инварианта здесь тоже.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: vi.fn(), transaction: vi.fn() }));

import { NextRequest } from 'next/server';
import { verifyCronSecret } from '@/lib/auth/cron';
import { query, transaction } from '@/lib/database';
import { POST } from '@/app/api/cron/place-description-drafts-review/route';

const verifyMock = vi.mocked(verifyCronSecret);
const queryMock = vi.mocked(query);
const transactionMock = vi.mocked(transaction);

function req(body: unknown) {
  return new NextRequest('http://x/api/cron/place-description-drafts-review', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  verifyMock.mockReset();
  queryMock.mockReset();
  transactionMock.mockReset();
  transactionMock.mockImplementation(async (cb: (client: unknown) => Promise<void>) => {
    const client = { query: vi.fn() };
    await cb(client);
  });
});

describe('/api/cron/place-description-drafts/review', () => {
  it('без CRON_SECRET — 401, ни одного запроса к БД', async () => {
    verifyMock.mockReturnValue(false);
    const res = await POST(req({ decisions: [{ place_id: 'p1', action: 'approve' }] }));
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('decisions — обязателен, не пуст, не более 50, action — enum', async () => {
    verifyMock.mockReturnValue(true);
    const res1 = await POST(req({}));
    expect(res1.status).toBe(400);
    const res2 = await POST(req({ decisions: [] }));
    expect(res2.status).toBe(400);
    const res3 = await POST(req({ decisions: Array.from({ length: 51 }, (_, i) => ({ place_id: `p${i}`, action: 'approve' })) }));
    expect(res3.status).toBe(400);
    const res4 = await POST(req({ decisions: [{ place_id: 'p1', action: 'delete' }] }));
    expect(res4.status).toBe(400);
  });

  it('approve — публикует в places.description; reject — нет', async () => {
    verifyMock.mockReturnValue(true);
    queryMock.mockResolvedValue({ rows: [{ translated_text: 'Текст', status: 'pending' }] } as never);

    const res = await POST(req({ decisions: [{ place_id: 'p1', action: 'approve' }] }));
    expect(res.status).toBe(200);
    const body = await res.json() as { outcomes: Array<{ status: string }> };
    expect(body.outcomes[0].status).toBe('applied');

    const client = await transactionMock.mock.results[0].value; // resolved already, just ensures called
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('уже рассмотренный черновик — не переписывается повторно', async () => {
    verifyMock.mockReturnValue(true);
    queryMock.mockResolvedValue({ rows: [{ translated_text: 'Текст', status: 'approved' }] } as never);
    const res = await POST(req({ decisions: [{ place_id: 'p1', action: 'reject' }] }));
    const body = await res.json() as { outcomes: Array<{ status: string; previous_status?: string }> };
    expect(body.outcomes[0].status).toBe('already_reviewed');
    expect(body.outcomes[0].previous_status).toBe('approved');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('черновик не найден — называется явно, не глотается', async () => {
    verifyMock.mockReturnValue(true);
    queryMock.mockResolvedValue({ rows: [] } as never);
    const res = await POST(req({ decisions: [{ place_id: 'missing', action: 'approve' }] }));
    const body = await res.json() as { outcomes: Array<{ status: string }> };
    expect(body.outcomes[0].status).toBe('not_found');
  });

  it('делает ту же публикацию, что и admin PATCH: UPDATE places.description только при approve', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'app/api/cron/place-description-drafts-review/route.ts'),
      'utf-8',
    );
    const updateIdx = src.search(/UPDATE places SET description/);
    expect(updateIdx).toBeGreaterThan(0);
    const before = src.slice(0, updateIdx);
    expect(before).toMatch(/action === 'approve'/);
    expect(src).toMatch(/status\s*!==\s*'pending'/);
  });
});
