import { describe, it, expect } from 'vitest';
import { kamchatkaDateContext } from '@/lib/kuzmich/date-context';

describe('kamchatkaDateContext', () => {
  it('22.10.2026 00:30 Камчатка — четверг, выходные 24–25 октября', () => {
    const t = Date.UTC(2026, 9, 21, 12, 30); // = 22.10 00:30 UTC+12
    const s = kamchatkaDateContext(t);
    expect(s).toContain('СЕГОДНЯ: 22 октября 2026 (четверг), 00:30');
    expect(s).toContain('24 октября 2026 (суббота) и 25 октября 2026 (воскресенье)');
  });
  it('в воскресенье ближайшие выходные — текущие', () => {
    const s = kamchatkaDateContext(Date.UTC(2026, 9, 25, 0, 0)); // 25.10 12:00 вс
    expect(s).toContain('24 октября 2026 (суббота) и 25 октября 2026 (воскресенье)');
  });
});
