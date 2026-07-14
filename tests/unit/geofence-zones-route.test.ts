/**
 * Геофенс опасных зон.
 * - Все источники зон фильтруют is_visible = TRUE (скрытые места-статьи не рождают алертов).
 * - Вулканическая зона строится ТОЛЬКО для вулканов с повышенным кодом KVERT
 *   (yellow/orange/red). Потухшая/спокойная сопка (Мишенная) красной зоны не даёт.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { GET } from '@/app/api/safety/geofence-zones/route';

describe('GET /api/safety/geofence-zones', () => {
  beforeEach(() => queryMock.mockReset());

  it('все источники зон фильтруют is_visible = TRUE', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await GET();

    // Три запроса: вулканы (JOIN volcano_status), термальные/гейзеры, цунами.
    expect(queryMock).toHaveBeenCalledTimes(3);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0]).toLowerCase()).toContain('is_visible');
    }
  });

  it('вулкан с повышенным кодом KVERT (orange) → критическая зона', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('volcano_status')) {
        return Promise.resolve({ rows: [{ id: 'v1', name: 'Ключевская сопка', lat: 56.05, lng: 160.64, acc: 'orange' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await GET();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.fallback).toBe(false);
    expect(body.zones).toHaveLength(1);
    expect(body.zones[0]).toMatchObject({ hazard: 'volcano', level: 'critical', name: 'Ключевская сопка' });
    expect(body.zones[0].message).toContain('KVERT');
  });

  it('нет вулканов с повышенным кодом → нет вулканической зоны (потухшая сопка не алертит)', async () => {
    // volcano_status-запрос уже отфильтровал по ACC и вернул пусто; есть только термальные.
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes("location_type IN ('hot_spring'")) {
        return Promise.resolve({ rows: [{ id: 't1', name: 'Паратунка', lat: 52.9, lng: 158.2, location_type: 'hot_spring' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await GET();
    const body = await res.json();
    expect(body.zones.some((z: { hazard: string }) => z.hazard === 'volcano')).toBe(false);
    expect(body.zones.some((z: { hazard: string }) => z.hazard === 'thermal')).toBe(true);
  });

  it('сбой БД → пустые зоны + fallback, не синтетика', async () => {
    let n = 0;
    queryMock.mockImplementation(() => {
      n += 1;
      return n === 1 ? Promise.reject(new Error('db down')) : Promise.resolve({ rows: [] });
    });
    const res = await GET();
    const body = await res.json();
    expect(body.fallback).toBe(true);
    expect(body.zones).toEqual([]);
  });
});
