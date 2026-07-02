import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkRouteOfflineReadiness, hasValidTrack } from '@/lib/services/offline-readiness';

// Реальный setup-файл проекта — test/setup.ts (см. vitest.config.ts) — не
// мокает @/lib/database глобально (есть и неиспользуемый tests/setup.ts,
// не подключённый в конфиге — не полагаемся на него). Мокаем локально,
// как и db-pool в остальных тестах этого файла.
const mockQuery = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

describe('hasValidTrack', () => {
  it('is true for a LineString with 2+ coordinates', () => {
    expect(hasValidTrack({ coordinates: [[158.6, 53.2], [158.7, 53.3]] })).toBe(true);
  });

  it('is false for null/missing geometry', () => {
    expect(hasValidTrack(null)).toBe(false);
  });

  it('is false for a single-point (degenerate) track', () => {
    expect(hasValidTrack({ coordinates: [[158.6, 53.2]] })).toBe(false);
  });

  it('is false when coordinates is not an array', () => {
    expect(hasValidTrack({ coordinates: 'not-an-array' } as unknown as { coordinates?: unknown })).toBe(false);
  });
});

describe('checkRouteOfflineReadiness (issue #246 — offline SOS package integrity)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for a route that does not exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await checkRouteOfflineReadiness('missing-id');
    expect(r).toBeNull();
  });

  it('flags hasGeometry=false and readinessPercent<100 for a route without a track', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ geometry: null, mchs_phone: '+7-415-2-11-05-05', description: 'Маршрут к вулкану' }],
    });

    const r = await checkRouteOfflineReadiness('route-1');

    expect(r).not.toBeNull();
    expect(r!.hasGeometry).toBe(false);
    expect(r!.readinessPercent).toBeLessThan(100);
  });

  it('returns readinessPercent=100 when geometry, contact and description are all present', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        geometry: { coordinates: [[158.6, 53.2], [158.7, 53.3]] },
        mchs_phone: '+7-415-2-11-05-05',
        description: 'Маршрут к вулкану',
      }],
    });

    const r = await checkRouteOfflineReadiness('route-2');

    expect(r).toEqual({
      routeId: 'route-2',
      hasGeometry: true,
      hasRescueContacts: true,
      hasDescription: true,
      readinessPercent: 100,
    });
  });

  it('reads only from v_kamchatka_routes_api', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await checkRouteOfflineReadiness('route-3');
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain('v_kamchatka_routes_api');
    expect(sql).not.toMatch(/FROM\s+kamchatka_routes\b/i);
  });
});
