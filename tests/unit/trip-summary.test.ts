import { describe, it, expect } from 'vitest';
import { tripSummary } from '@/lib/trip/trip-summary';
describe('tripSummary', () => {
  it('пусто', () => expect(tripSummary([]).tone).toBe('bad'));
  it('все подтверждены', () => expect(tripSummary(['confirmed', 'confirmed']).ru).toMatch('2 из 2'));
  it('ждём', () => expect(tripSummary(['awaiting_operator', 'confirmed']).ru).toMatch('подтверждено 1 из 2'));
  it('нужен ответ', () => expect(tripSummary(['other_date', 'confirmed']).tone).toBe('act'));
  it('не прочитан', () => expect(tripSummary([null, 'awaiting_operator']).tone).toBe('bad'));
  it('без «мгновенн»', () => expect(JSON.stringify(['confirmed', null, 'declined'].map((s) => tripSummary([s as never])))).not.toMatch(/мгновенн|временно/));
});
