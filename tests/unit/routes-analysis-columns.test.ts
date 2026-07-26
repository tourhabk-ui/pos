/**
 * Анализ маршрутов (/api/routes/analysis) — регрессия «column ot.lat does not exist».
 * operator_tours хранит координаты в latitude/longitude, а не lat/lng — JOIN по
 * ot.lat падал 500-й, страница показывала ошибку. Плюс total_bookings считался
 * как SUM(b.id) (сумма id брони — бессмыслица), а не COUNT.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('app/api/routes/analysis/route.ts', 'utf8');

describe('routes/analysis SQL', () => {
  it('JOIN operator_tours по latitude/longitude, не lat/lng', () => {
    expect(src).toMatch(/ot\.latitude/);
    expect(src).toMatch(/ot\.longitude/);
    expect(src).not.toMatch(/ot\.lat\b/);
    expect(src).not.toMatch(/ot\.lng\b/);
  });

  it('total_bookings через COUNT(DISTINCT b.id), не SUM(b.id)', () => {
    expect(src).toMatch(/COUNT\(DISTINCT b\.id\) as total_bookings/);
    expect(src).not.toMatch(/SUM\(b\.id\)/);
  });
});
