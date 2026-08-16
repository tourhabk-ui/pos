/**
 * Фильтр «Рядом» каталога: валидация near-параметров схемой и построение
 * SQL-условия гаверсинуса в queryCatalog (мок query — проверяем сам SQL).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({ query: vi.fn() }));

import { query } from '@/lib/database';
import { CatalogQuerySchema, queryCatalog } from '@/lib/routes/catalog-query';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
});

describe('CatalogQuerySchema — near-параметры', () => {
  it('принимает валидные координаты и радиус', () => {
    const p = CatalogQuerySchema.parse({ near_lat: '53.02', near_lng: '158.65', radius_km: '100' });
    expect(p.near_lat).toBeCloseTo(53.02);
    expect(p.radius_km).toBe(100);
  });

  it('отклоняет координаты вне диапазона и нулевой радиус', () => {
    expect(CatalogQuerySchema.safeParse({ near_lat: '91' }).success).toBe(false);
    expect(CatalogQuerySchema.safeParse({ near_lng: '181' }).success).toBe(false);
    expect(CatalogQuerySchema.safeParse({ radius_km: '0' }).success).toBe(false);
  });
});

describe('queryCatalog — SQL фильтра «Рядом»', () => {
  it('с near-параметрами добавляет гаверсинус и передаёт их в params', async () => {
    const filters = CatalogQuerySchema.parse({
      kind: 'place', near_lat: '53.0195', near_lng: '158.6505', radius_km: '50',
    });
    await queryCatalog(filters);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('6371 * acos(least(1.0,');
    // Колонки квалифицированы префиксом ark: в запросе есть JOIN, и голое
    // `lat` в нём неоднозначно — каталог из-за этого падал (проба 84).
    expect(sql).toContain('ark.lat IS NOT NULL AND ark.lng IS NOT NULL');
    expect(params).toEqual(expect.arrayContaining([53.0195, 158.6505, 50]));
  });

  it('без радиуса гаверсинуса в SQL нет', async () => {
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'place' }));
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).not.toContain('acos');
  });

  it('has_waypoints=true добавляет EXISTS по route_waypoints (рекомендуемые планировщика)', async () => {
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'route', has_waypoints: 'true' }));
    const [sql] = queryMock.mock.calls[0] as [string];
    // Точки ищутся через строку kamchatka_routes по обоим id: id VIEW —
    // COALESCE(ark_id, id), а route_waypoints.route_id живёт на kr.id.
    expect(sql).toContain('JOIN route_waypoints rwx ON rwx.route_id = kw.id');
    expect(sql).toContain('kw.id = ark.id OR kw.ark_id = ark.id');
  });

  it('has_waypoints=true требует компактность вейпоинтов (мега-сборники — не треки)', async () => {
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'route', has_waypoints: 'true' }));
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toContain('MAX(p.lat) - MIN(p.lat)');
    expect(sql).toContain('<= 0.5');
    expect(sql).toContain('<= 0.8');
  });
});
