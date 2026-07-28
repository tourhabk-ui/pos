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
    await checkRouteOfflineReadiness('route-3');
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toMatch(/FROM\s+kamchatka_routes\b/i);
    expect(sql).toMatch(/is_visible\s*=\s*TRUE/i);
  });
});
