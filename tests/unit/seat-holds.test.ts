import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
import { pool } from '@/lib/db-pool';
import { holdPress, parseHoldPress } from '@/lib/operators/seat-holds';
import { holdButtons } from '@/lib/operators/seat-hold-buttons';

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const P = '11111111-2222-4333-8444-555555555555';
const strip = (p: string) => p.split('~')[0]!;

describe('«Занять места» (PR4)', () => {
  it('кнопки ≤64 байт и разбираются', () => {
    for (const held of [true, false]) {
      const b = holdButtons(ID, held)[0]!;
      expect(Buffer.byteLength(b.payload)).toBeLessThanOrEqual(64);
      expect(parseHoldPress(strip(b.payload))).toMatchObject({ requestId: ID });
    }
    expect(parseHoldPress('sh:n')).toBe('no');
    expect(parseHoldPress('sh:y:not-a-uuid')).toBeNull();
  });
  it('в группе запись не делается', async () => {
    const r = await holdPress({ partnerId: P, userId: null, payload: `sh:y:${ID}`, via: 'max', dialog: false });
    expect(r?.text).toMatch(/личном/);
    expect(pool.query).not.toHaveBeenCalled();
  });
  it('чужой запрос — ничего не пишет', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const r = await holdPress({ partnerId: P, userId: null, payload: `sh:y:${ID}`, via: 'telegram', dialog: true });
    expect(r?.text).toMatch(/среди ваших нет/);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
  it('первое нажатие только спрашивает и честно говорит «не бронь»', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ tour_id: '5', d: '2026-11-20', participants: 3, held: null }] } as never);
    const r = await holdPress({ partnerId: P, userId: null, payload: `sh:h:${ID}`, via: 'telegram', dialog: true });
    expect(r?.text).toMatch(/Занять 3 мест на 20\.11 под этот запрос\?.*не бронь/);
    expect(strip(r!.rows[0]![0]!.payload)).toBe(`sh:y:${ID}`);
  });
});
