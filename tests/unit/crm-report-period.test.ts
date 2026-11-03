import { describe, expect, it } from 'vitest';
import { foldRows, periodRange, periodReportText, rub } from '@/lib/crm/report-period';

// 03.11.2026 08:00 UTC = 03.11 20:00 Камчатка (вторник)
const NOW = Date.parse('2026-11-03T08:00:00Z');

describe('periodRange', () => {
  it('недели пн–вс по Камчатке', () => {
    expect(periodRange('this_week', NOW)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(periodRange('last_week', NOW)).toEqual({ from: '2026-10-26', to: '2026-11-01' });
  });
  it('месяцы', () => {
    expect(periodRange('this_month', NOW)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodRange('last_month', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });
  it('граница суток: 1 ноября 13:00 UTC — уже 2 ноября на Камчатке (понедельник)', () => {
    expect(periodRange('this_week', Date.parse('2026-11-01T13:00:00Z')).from).toBe('2026-11-02');
    expect(periodRange('this_month', Date.parse('2026-10-31T12:30:00Z')).from).toBe('2026-11-01');
  });
});

describe('отчёт', () => {
  const rows = [
    { basis: 'created' as const, title: 'Рыбалка', status: 'confirmed', n: 2, paid: '50000.50' },
    { basis: 'created' as const, title: 'Рыбалка', status: 'cancelled', n: 1, paid: 0 },
    { basis: 'trip' as const, title: 'Зимняя', status: 'new', n: 1, paid: null },
  ];
  it('сворачивает по основанию, деньги без округления', () => {
    const c = foldRows(rows, 'created');
    expect(c.total).toBe(3);
    expect(c.paidRub).toBe(50000.5);
    expect(rub(c.paidRub)).toBe('50 000,5 ₽');
  });
  it('текст: оба счёта, без ПД, ошибка — без цифр', () => {
    const t = periodReportText({ period: 'last_week', from: '2026-10-26', to: '2026-11-01', byCreated: foldRows(rows, 'created'), byTrip: foldRows(rows, 'trip'), leads: 4 });
    expect(t).toContain('Прошлая неделя: 26.10–01.11');
    expect(t).toContain('По дате оформления брони');
    expect(t).toContain('По дате поездки');
    expect(t).toContain('подтверждено 2, отменено 1');
    expect(t).not.toMatch(/\+7|@/);
    expect(periodReportText(null)).not.toMatch(/\d+ ₽/);
  });
  it('пусто — «броней нет»', () => {
    const t = periodReportText({ period: 'this_week', from: '2026-11-02', to: '2026-11-08', byCreated: foldRows([], 'created'), byTrip: foldRows([], 'trip'), leads: 0 });
    expect(t.match(/броней нет/g)).toHaveLength(2);
  });
});
