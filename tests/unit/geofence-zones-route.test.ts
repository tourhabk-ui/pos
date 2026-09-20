/**
 * Геофенс опасных зон.
 * - У КАЖДОГО источника зон есть гейт видимости: непроверенная строка не
 *   становится живой тревогой в поле.
 * - Вулканическая зона строится ТОЛЬКО для вулканов с повышенным кодом KVERT
 *   (yellow/orange/red). Потухшая/спокойная сопка (Мишенная) красной зоны не даёт.
 *
 * 19.09 (#1957): источников стало четыре — добавились медвежьи зоны из
 * наблюдений туристов. Гейт у них ДРУГОЙ по природе: у `trail_reports` нет
 * колонки `is_visible`, потому что это не места-статьи, а сообщения людей;
 * их отсеивает ручная модерация владельца (`status = 'approved'`). Поэтому
 * правило здесь названо по смыслу и проверяется поимённо для каждого
 * источника — иначе новый источник прошёл бы мимо «всех» незамеченным.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { GET } from '@/app/api/safety/geofence-zones/route';

describe('GET /api/safety/geofence-zones', () => {
  beforeEach(() => queryMock.mockReset());

  it('у каждого источника зон есть свой гейт видимости', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await GET();

    // Четыре запроса: вулканы (JOIN volcano_status), термальные/гейзеры,
    // цунами, медвежьи наблюдения.
    expect(queryMock).toHaveBeenCalledTimes(4);

    const sql = queryMock.mock.calls.map((c) => String(c[0]).toLowerCase());
    const find = (needle: string) => {
      const hit = sql.filter((q) => q.includes(needle));
      expect(hit, `источник «${needle}» не найден среди запросов`).toHaveLength(1);
      return hit[0];
    };

    // Места-статьи: скрытое место зоны не рождает.
    expect(find('volcano_status')).toContain('is_visible');
    expect(find("location_type in ('hot_spring'")).toContain('is_visible');
    expect(find('tsunami_risk')).toContain('is_visible');

    // Сообщения людей: гейт — ручная модерация, колонки is_visible там нет.
    const bear = find('trail_reports');
    expect(bear, 'наблюдение без модерации стало бы тревогой в поле')
      .toContain("status = 'approved'");
    expect(bear, 'без срока годности наблюдение предупреждало бы вечно')
      .toContain("interval '1 day' * $1");
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
