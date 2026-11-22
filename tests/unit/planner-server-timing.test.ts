/** Server-Timing замера этапов (фича 7): только имена этапов и числа. */
import { describe, it, expect } from 'vitest';
import { serverTiming } from '@/lib/planner/server-timing';

describe('serverTiming', () => {
  it('этапы и total, мс округлены', () => {
    expect(serverTiming([['alerts', 120.4], ['ai_itinerary', 9000]], 9500)).toBe('alerts;dur=120, ai_itinerary;dur=9000, total;dur=9500');
  });
  it('чужое имя (не a-z_) не попадает в заголовок', () => {
    expect(serverTiming([['bad name; x', 1]], 2)).toBe('total;dur=2');
  });
});
