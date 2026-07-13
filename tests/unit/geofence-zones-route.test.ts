/**
 * Геофенс опасных зон: жизне-безопасные зоны берутся ТОЛЬКО из видимых мест.
 * Скрытые (is_visible=false) места-статьи/события (напр. «Гонка среди вулканов»)
 * не должны рождать вулканических/цунами-зон и ложных 112-алертов.
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

    // Три запроса: places (volcano/hot_spring/geyser), kamchatka_routes, tsunami-join
    expect(queryMock).toHaveBeenCalledTimes(3);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0]).toLowerCase()).toContain('is_visible');
    }
  });

  it('строит зону из видимого вулкана', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes("location_type IN")) {
        return Promise.resolve({ rows: [{ id: 'v1', name: 'Ключевская', lat: 56.05, lng: 160.64, location_type: 'volcano' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await GET();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.fallback).toBe(false);
    expect(body.zones).toHaveLength(1);
    expect(body.zones[0]).toMatchObject({ hazard: 'volcano', level: 'danger', name: 'Ключевская' });
  });

  it('сбой БД → пустые зоны + fallback, не синтетика', async () => {
    // Только первый запрос падает (иначе братья-промисы Promise.all остаются
    // необработанными); Promise.all отвергается первым — ветка catch срабатывает.
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
