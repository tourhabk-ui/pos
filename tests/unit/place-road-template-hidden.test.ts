// @vitest-environment node
/**
 * Дорога к месту из умолчания 0645 в ответ карточки не уходит (15.10, §0).
 *
 * У всех мест в location_safety_profile стоит road_type = 'gravel' и
 * road_accessibility = 50 — умолчание миграции 0645, замеров нет
 * (lib/places/on-route.ts, lib/places/access-text.ts). Экран их не рисовал, но
 * JSON карточки отдавал: у кальдеры Узона, куда летают вертолётом, —
 * «гравийка, доступность 50» (проба 967). Ответ читают и внешние агенты.
 *
 * Вызовом загрузчика с подставной базой: строка с умолчанием дороги — в ответе
 * ни поля, ни значения.
 */
import { describe, it, expect, vi } from 'vitest';

describe('карточка места не отдаёт умолчание дороги', () => {
  it('road_type «gravel» и доступность 50 — ни поля, ни значения в ответе', async () => {
    vi.resetModules();
    vi.doMock('@/lib/database', () => ({
      query: async (sql: string) => ({
        rows: /FROM places p\s+LEFT JOIN place_description_drafts/.test(sql)
          ? [{
              place_pk: 'test-place-0002', ark_id: '33333333-3333-3333-3333-333333333333', name: 'Узон (тест)',
              lat: 54.51, lng: 159.92, location_type: 'volcano', photo_count: 0, coord_source: null,
              profile_source: 'type_template', road_type: 'gravel', road_accessibility: 50,
            }]
          : [],
      }),
    }));
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: async () => ({ rows: [] }) } }));
    const { loadPlaceDetail } = await import('@/lib/places/place-detail');
    const r = await loadPlaceDetail('test-place-0002', { countView: false });
    const safety = (r.body.data as { safety: Record<string, unknown> }).safety;
    expect(safety).toBeTruthy();
    expect(Object.keys(safety)).not.toContain('roadType');
    expect(Object.keys(safety)).not.toContain('roadAccessibility');
    expect(JSON.stringify(r.body)).not.toContain('gravel');
  });
});
