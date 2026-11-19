/**
 * Layout пропускает весь /zh, чтобы страницы, которые сами зовут
 * recordZhEntryHit, не писали сырой UA дважды. Посадочные /zh/booking и
 * /zh/volcano-tours — тоже /zh: без своего вызова обходчик туда не попадает
 * ни в agent_entry_hits, ни в ai_crawler_ua.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hit, loadTours } = vi.hoisted(() => ({
  hit: vi.fn(),
  loadTours: vi.fn(async () => [] as unknown[]),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'user-agent' ? 'Mozilla/5.0 (compatible; Baiduspider/2.0)' : null),
  }),
}));

vi.mock('@/lib/analytics/agent-entry-hits', () => ({
  recordZhEntryHit: (...args: unknown[]) => hit(...args),
}));

vi.mock('@/lib/seo/query-landings-data', () => ({
  loadLandingTours: (...args: unknown[]) => loadTours(...args),
}));

vi.mock('@/lib/seo/query-landings-parks', () => ({
  loadLandingParks: async () => [],
}));

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/seo/QueryLanding', () => ({ QueryLandingView: () => null }));

describe('китайские посадочные пишут сырой UA', () => {
  beforeEach(() => {
    hit.mockClear();
    loadTours.mockReset();
    loadTours.mockResolvedValue([]);
  });

  it('/zh/booking и /zh/volcano-tours зовут recordZhEntryHit до чтения туров', async () => {
    const booking = (await import('@/app/zh/booking/page')).default;
    const volcano = (await import('@/app/zh/volcano-tours/page')).default;
    loadTours.mockRejectedValueOnce(new Error('каталог не прочитан'));
    await expect(booking()).rejects.toThrow('каталог не прочитан');
    expect(hit).toHaveBeenCalledWith('/zh/booking', 'Mozilla/5.0 (compatible; Baiduspider/2.0)');
    await volcano();
    expect(hit).toHaveBeenCalledWith('/zh/volcano-tours', 'Mozilla/5.0 (compatible; Baiduspider/2.0)');
  });
});
