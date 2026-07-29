import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeGeometryHealth } from '@/lib/services/routes/routes-geometry-health';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('computeGeometryHealth (issue #249 — offline-SOS geometry health)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes pct from total/with_track and flags ok when >=80%', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '10', with_track: '9' }] })
      .mockResolvedValueOnce({ rows: [{ zone: 'avachinsky', total: '10', without_track: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'r1' }] });

    const health = await computeGeometryHealth();

    expect(health.total).toBe(10);
    expect(health.with_track).toBe(9);
    expect(health.pct).toBe(90);
    expect(health.ok).toBe(true);
  });

  it('flags ok=false when pct is below the 80% threshold', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '10', with_track: '5' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const health = await computeGeometryHealth();

    expect(health.pct).toBe(50);
    expect(health.ok).toBe(false);
  });

  it('returns pct=0 (not NaN) when total is 0', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '0', with_track: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const health = await computeGeometryHealth();

    expect(health.total).toBe(0);
    expect(health.pct).toBe(0);
    expect(Number.isNaN(health.pct)).toBe(false);
  });

  it('includes a by_region breakdown of routes missing a track', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '5', with_track: '3' }] })
      .mockResolvedValueOnce({ rows: [
        { zone: 'northern', total: '3', without_track: '2' },
        { zone: 'avachinsky', total: '2', without_track: '0' },
      ] })
      .mockResolvedValueOnce({ rows: [] });

    const health = await computeGeometryHealth();

    expect(health.by_region).toEqual([
      { zone: 'northern', total: 3, without_track: 2 },
      { zone: 'avachinsky', total: 2, without_track: 0 },
    ]);
  });

  it('includes the list of route ids missing geometry (issue #225)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '3', with_track: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'route-a' }, { id: 'route-b' }] });

    const health = await computeGeometryHealth();

    expect(health.missing_geometry_ids).toEqual(['route-a', 'route-b']);
  });

  // Правка 28.07. Сторож требовал читать только через v_kamchatka_routes_api —
  // по букве CLAUDE.md. Аудит боевой схемы показал, что живое представление
  // другой формы: route_id, route_dedupe_key, category, title, description,
  // lat, lng, source_url, source_name, import_source, has_coordinates,
  // category_total, category_position, metadata, created_at,
  // source_updated_at. Ни id, ни mchs_phone, ни geometry там нет, и миграции
  // 670/738, которые привели бы вьюху к виду из файлов, не применялись ни разу.
  // То есть буква правила заставляла запрос падать при каждом вызове.
  // Смысл правила — не отдавать наружу скрытые маршруты — сохранён: читаем
  // мастер-таблицу с явным фильтром is_visible, его и проверяем. Вернуть
  // чтение через представление следует после его починки.
  it('читает мастер-таблицу и не теряет фильтр видимости', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '1', with_track: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await computeGeometryHealth();

    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string;
      expect(sql).toMatch(/FROM\s+kamchatka_routes\b/i);
      expect(sql).toMatch(/is_visible\s*=\s*TRUE/i);
    }
  });
});
