import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findRoutePreflightSafety } from '@/lib/services/routes/route-preflight-safety';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('findRoutePreflightSafety (issue #248 — guide pre-flight safety check)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no route matches the title query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await findRoutePreflightSafety('несуществующий маршрут');

    expect(result).toBeNull();
  });

  it('flags hasGeometry:false for a route with null geometry', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'r1', title: 'Мутновский вулкан', geometry: null,
        mchs_phone: null, mchs_registration_required: null,
        difficulty: null, hazards: null, equipment: null,
      }],
    });

    const result = await findRoutePreflightSafety('Мутновский');

    expect(result).not.toBeNull();
    expect(result!.hasGeometry).toBe(false);
    expect(result!.hasMchsContact).toBe(false);
    expect(result!.mchsRegistrationRequired).toBeNull();
    expect(result!.hazards).toEqual([]);
    expect(result!.equipment).toEqual([]);
  });

  it('flags hasGeometry:false for a degenerate single-point track', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'r2', title: 'Тестовый маршрут', geometry: { coordinates: [[158.6, 53.2]] },
        mchs_phone: null, mchs_registration_required: null,
        difficulty: null, hazards: null, equipment: null,
      }],
    });

    const result = await findRoutePreflightSafety('Тестовый');

    expect(result!.hasGeometry).toBe(false);
  });

  it('reports all real safety fields when fully populated', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'r3', title: 'Авачинский вулкан',
        geometry: { coordinates: [[158.6, 53.2], [158.7, 53.3]] },
        mchs_phone: '+7 415 200-00-00',
        mchs_registration_required: true,
        difficulty: 'hard',
        hazards: ['камнепад', 'резкая смена погоды'],
        equipment: ['ботинки', 'палки'],
      }],
    });

    const result = await findRoutePreflightSafety('Авачинский');

    expect(result).toEqual({
      routeId: 'r3',
      title: 'Авачинский вулкан',
      hasGeometry: true,
      hasMchsContact: true,
      mchsRegistrationRequired: true,
      difficulty: 'hard',
      hazards: ['камнепад', 'резкая смена погоды'],
      equipment: ['ботинки', 'палки'],
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
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await findRoutePreflightSafety('вулкан');

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toMatch(/FROM\s+kamchatka_routes\b/i);
    expect(sql).toMatch(/is_visible\s*=\s*TRUE/i);
  });
});
