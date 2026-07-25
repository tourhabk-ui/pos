/**
 * Маркер источника геометрии: OSM-раннер пишет in-band source='osm' и
 * апгрейдит синтетику миграции 168 (waypoints_synthetic), не трогая
 * реальные треки. Конвенцию source внутри GeoJSON уже читает дедуп
 * idilesom-скрипта — раннер обязан ей следовать.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { runOsmGeometryImport } from '@/lib/import/osm-import-runner';

// Трек Overpass: 3 узла в паре сотен метров от точки маршрута (53.0, 158.6)
const OVERPASS_WAY = {
  id: 1,
  tags: { highway: 'path' },
  geometry: [
    { lat: 53.001, lon: 158.601 },
    { lat: 53.005, lon: 158.605 },
    { lat: 53.010, lon: 158.610 },
  ],
};

const ROUTE_ROW = { id: 'r1', title: 'Тестовый маршрут', lat: '53.0', lng: '158.6' };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/SELECT id, title/.test(sql)) return { rows: [ROUTE_ROW] };
    if (/FILTER \(WHERE geometry IS NULL\)/.test(sql)) {
      return { rows: [{ without_geometry: '1', synthetic: '4' }] };
    }
    return { rows: [] };
  });
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ elements: [OVERPASS_WAY] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runOsmGeometryImport — маркер источника', () => {
  it('пул выборки включает синтетику, реальные треки — нет', async () => {
    await runOsmGeometryImport({ limit: 8, dryRun: true, delayMs: 0 });
    const selectSql = queryMock.mock.calls.find(c => /SELECT id, title/.test(c[0] as string))?.[0] as string;
    expect(selectSql).toMatch(/geometry IS NULL OR geometry->>'source' = 'waypoints_synthetic'/);
    // Совсем без геометрии — первыми
    expect(selectSql).toMatch(/ORDER BY \(geometry IS NULL\) DESC/);
  });

  it('импортированный трек несёт source=osm внутри GeoJSON', async () => {
    const result = await runOsmGeometryImport({ limit: 8, dryRun: false, delayMs: 0 });
    expect(result.imported).toBe(1);

    const updateCall = queryMock.mock.calls.find(c => /UPDATE kamchatka_routes SET geometry/.test(c[0] as string));
    expect(updateCall).toBeTruthy();
    const written = JSON.parse((updateCall![1] as string[])[0]);
    expect(written.source).toBe('osm');
    expect(written.type).toBe('LineString');
    expect(written.coordinates.length).toBe(3);
  });

  it('счётчики: NULL и синтетика раздельно, remaining_total — их сумма', async () => {
    const result = await runOsmGeometryImport({ limit: 8, dryRun: true, delayMs: 0 });
    expect(result.routes_without_geometry).toBe(1);
    expect(result.routes_synthetic).toBe(4);
    expect(result.remaining_total).toBe(5);
  });

  it('нет трека в OSM — skip без записи: синтетика остаётся, не затирается', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ elements: [] }) });
    const result = await runOsmGeometryImport({ limit: 8, dryRun: false, delayMs: 0 });
    expect(result.skipped).toBe(1);
    expect(queryMock.mock.calls.some(c => /UPDATE kamchatka_routes/.test(c[0] as string))).toBe(false);
  });
});

describe('структурно: бэкфилл синтетики осторожный', () => {
  it('миграция 776 требует сигнатуру целиком: точное совпадение первой точки И малое число точек И отсутствие source', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('migrations/776_geometry_source_backfill.sql', 'utf8');
    expect(src).toMatch(/geometry->>'source' IS NULL/);
    expect(src).toMatch(/jsonb_array_length\(geometry->'coordinates'\) <= 12/);
    expect(src).toMatch(/geometry->'coordinates'->0->>0\)::float8 = lng::float8/);
    expect(src).toMatch(/geometry->'coordinates'->0->>1\)::float8 = lat::float8/);
    // Идемпотентность: повторный прогон не найдёт строк (source уже проставлен)
    expect(src).toMatch(/ON CONFLICT \(name\) DO NOTHING/);
  });
});
