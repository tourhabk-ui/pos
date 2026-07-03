import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computePlacesQuality } from '@/lib/services/places-quality';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('computePlacesQuality (issue #226 — places data completeness after import)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes ratios from total/with_coords/with_description/with_category', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '10', with_coords: '9', with_description: '8', with_category: '10' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'p1' }] });

    const quality = await computePlacesQuality();

    expect(quality.total).toBe(10);
    expect(quality.coordsRatio).toBe(90);
    expect(quality.descriptionRatio).toBe(80);
    expect(quality.categoryRatio).toBe(100);
    expect(quality.missingCoordsIds).toEqual(['p1']);
  });

  it('returns ratio=0 (not NaN) when total is 0', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '0', with_coords: '0', with_description: '0', with_category: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const quality = await computePlacesQuality();

    expect(quality.total).toBe(0);
    expect(quality.coordsRatio).toBe(0);
    expect(Number.isNaN(quality.coordsRatio)).toBe(false);
  });

  it('filters by source_name via ILIKE when source is passed', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '5', with_coords: '5', with_description: '5', with_category: '5' }] })
      .mockResolvedValueOnce({ rows: [] });

    await computePlacesQuality('idilesom');

    const [totalsSql, totalsParams] = mockQuery.mock.calls[0]!;
    expect(totalsSql).toContain('source_name ILIKE');
    expect(totalsParams).toEqual(['%idilesom%']);
  });

  it('excludes already soft-merged duplicates (merged_into_id IS NOT NULL)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '1', with_coords: '1', with_description: '1', with_category: '1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await computePlacesQuality();

    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string;
      expect(sql).toContain('merged_into_id IS NULL');
    }
  });

  it('caps the missing-coords list and queries places directly (not a view)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '3', with_coords: '1', with_description: '3', with_category: '3' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] });

    const quality = await computePlacesQuality();

    expect(quality.missingCoordsIds).toEqual(['a', 'b']);
    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string;
      expect(sql).toMatch(/FROM\s+places\b/i);
    }
  });
});
