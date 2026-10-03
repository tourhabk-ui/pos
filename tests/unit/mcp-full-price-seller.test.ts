/**
 * Разбор UCP 03.10: ассистент, бронирующий за человека, обязан до
 * подтверждения знать ПОЛНУЮ сумму и ПРОДАВЦА. До этого MCP отдавал только
 * «от 18 000 ₽/чел. в день» и имя оператора без реквизитов.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
const availability = vi.fn();
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: (...a: unknown[]) => availability(...a),
}));
const honest = vi.fn();
vi.mock('@/lib/tours/honest-price', () => ({ honestTourPrice: (...a: unknown[]) => honest(...a) }));

import { pool } from '@/lib/db-pool';
import { getTourAvailabilityForKuzmich, parsePeople } from '@/lib/kuzmich/tour-availability-tool';

const q = pool.query as unknown as ReturnType<typeof vi.fn>;
const TOUR = { id: 37, title: 'Зимняя рыбалка', operator_id: 'op', base_price: 18000, price_unit: 'per_day_per_person', slug: 'zimnyaya', multi_day_count: null, duration_hours: null };

describe('итог брони в get_tour_availability', () => {
  beforeEach(() => { q.mockReset(); availability.mockReset(); honest.mockReset(); });

  it('people → итог той же функцией, что у брони, на каждую дату', async () => {
    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 10 }, { date: '2027-01-16', remaining: 4 }]);
    honest.mockResolvedValueOnce({ total: 54000 }).mockResolvedValueOnce({ total: 59400 });
    const out = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '2', people: '3' });
    expect(out).toContain('итого за 3 чел.: 54');
    expect(out).toContain('итого за 3 чел.: 59');
    expect(honest).toHaveBeenCalledWith(expect.objectContaining({ tourId: 37, tourDate: '2027-01-15', participants: 3, priceUnit: 'per_day_per_person' }));
    expect(out).toContain('Трансферы и услуги из «не входит» в неё не включены');
  });

  it('отказ расчёта на дате — «итог не посчитан», а не «от»', async () => {
    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 10 }]);
    honest.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }));
    const out = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '1', people: '2' });
    expect(out).toContain('итог не посчитан');
  });

  it('без people итог не считается и не выдумывается', async () => {
    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 10 }]);
    const out = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '1' });
    expect(honest).not.toHaveBeenCalled();
    expect(out).not.toContain('итого');
    expect(out).toContain('с параметром people');
  });

  it('people вне 1–30 — не распознан, названо вслух', async () => {
    expect(parsePeople('0')).toBeNull();
    expect(parsePeople('31')).toBeNull();
    expect(parsePeople('abc')).toBeNull();
    expect(parsePeople('4')).toBe(4);
    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 10 }]);
    const out = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '1', people: '50' });
    expect(out).toContain('не распознано (нужно 1–30)');
  });
});

describe('продавец в get_tour_details', () => {
  const core = readFileSync('lib/kuzmich/core.ts', 'utf8');
  it('строка продавца — общей функцией карточки, с честным «не записаны»', () => {
    expect(core).toMatch(/const requisites = sellerRequisitesLine\(t\)/);
    expect(core).toContain('Продавец (исполнитель тура):');
    expect(core).toContain('реквизиты на платформе не записаны');
    expect(core).toMatch(/legal_info->>'inn'/);
  });
  it('people прокинут от исполнителя до инструмента и описан в схемах', () => {
    expect(core).toMatch(/people: args\.people \}\)/);
    expect(readFileSync('lib/kuzmich/tool-schemas.ts', 'utf8')).toMatch(/people: \{ type: 'string'/);
    expect(readFileSync('lib/mcp/public-tools.ts', 'utf8')).toMatch(/people: \{ lead: 'Number of travellers/);
  });
});
