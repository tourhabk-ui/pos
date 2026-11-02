import { beforeEach, describe, expect, it, vi } from 'vitest';
const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
import { liveFreeSeats, forgetLiveSeats, LIVE_SEATS_TTL_MS } from '@/lib/operators/live-seats';

describe('живые места: кэш ≤30 с', () => {
  beforeEach(() => { query.mockReset(); forgetLiveSeats(); });
  it('TTL не больше 30 секунд', () => expect(LIVE_SEATS_TTL_MS).toBeLessThanOrEqual(30_000));
  it('в пределах 30 с — из кэша, после — снова база', async () => {
    query.mockResolvedValue({ rows: [{ free: 5 }] });
    expect(await liveFreeSeats(1, '2026-11-05', 0)).toBe(5);
    expect(await liveFreeSeats(1, '2026-11-05', 29_000)).toBe(5);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockResolvedValue({ rows: [{ free: 3 }] });
    expect(await liveFreeSeats(1, '2026-11-05', 30_000)).toBe(3);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('отказ базы — failed и не кэшируется', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await liveFreeSeats(2, '2026-11-05', 0)).toBe('failed');
    query.mockResolvedValue({ rows: [{ free: 1 }] });
    expect(await liveFreeSeats(2, '2026-11-05', 1)).toBe(1);
  });
});
