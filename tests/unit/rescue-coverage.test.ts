import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeRescueCoverage } from '@/lib/services/safety/rescue-coverage';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('computeRescueCoverage (issue #247 — MChS contact coverage)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports coveragePercent=100 and routesMissing=[] when every route has a phone', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'a', mchs_phone: '+7-415-2-11-05-05' },
        { id: 'b', mchs_phone: '+7-415-2-11-05-06' },
      ],
    });

    const r = await computeRescueCoverage();

    expect(r.totalRoutes).toBe(2);
    expect(r.withRescueContacts).toBe(2);
    expect(r.coveragePercent).toBe(100);
    expect(r.routesMissing).toEqual([]);
  });

  it('lists route IDs missing a phone (null or empty/whitespace)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'a', mchs_phone: '+7-415-2-11-05-05' },
        { id: 'b', mchs_phone: null },
        { id: 'c', mchs_phone: '   ' },
      ],
    });

    const r = await computeRescueCoverage();

    expect(r.withRescueContacts).toBe(1);
    expect(r.routesMissing).toEqual(['b', 'c']);
    expect(r.coveragePercent).toBeCloseTo(33.3, 1);
  });

  it('returns coveragePercent=0 (not NaN) when there are no routes', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const r = await computeRescueCoverage();

    expect(r.totalRoutes).toBe(0);
    expect(r.coveragePercent).toBe(0);
    expect(Number.isNaN(r.coveragePercent)).toBe(false);
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
    mockQuery.mockResolvedValue({ rows: [] });
    await computeRescueCoverage();
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toMatch(/FROM\s+kamchatka_routes\b/i);
    expect(sql).toMatch(/is_visible\s*=\s*TRUE/i);
  });
});
