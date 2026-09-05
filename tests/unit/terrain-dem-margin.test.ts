/**
 * Запас DEM за границей пакета (05.09).
 *
 * Тайл z8 заходит за границу клетки на полтайла. Без запаса его край —
 * дыра: гипсометрия красила её поверх соседа полосой (скрин владельца
 * 06:44), тень рисовала обрыв в 500 м швом вдоль каждого стыка. С запасом
 * тайл на стыке у обеих клеток одинаков и полон — шва нет по построению.
 * Сторож держит: запас не меньше тайла z8, мозаика строится на нём, а
 * число тайлов пакета считается по bbox; пересборка «только рельеф» не
 * трогает остального в хранилище.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PY = readFileSync(join(ROOT, 'scripts/map-tiles/build_terrain.py'), 'utf-8');
const UP = readFileSync(join(ROOT, 'scripts/map-tiles/upload-pack.ts'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/map-pack-build.yml'), 'utf-8');

describe('запас DEM', () => {
  it('не меньше тайла z8: 1.406° по долготе, до 0.85° по широте', () => {
    expect(Number(PY.match(/^DEM_MARGIN_LON = ([\d.]+)$/m)?.[1])).toBeGreaterThanOrEqual(1.41);
    expect(Number(PY.match(/^DEM_MARGIN_LAT = ([\d.]+)$/m)?.[1])).toBeGreaterThanOrEqual(0.85);
  });

  it('клетки DEM и мозаика — по bbox с запасом, тайлы пакета — по bbox', () => {
    expect(PY).toMatch(/paths = fetch_dem_tiles\(dem_bbox, args\.cache\)/);
    expect(PY).toMatch(/extent=cells_extent\(dem_bbox\)/);
    expect(PY).toMatch(/x0, x1, y0, y1 = tile_range\(bbox, z\)/);
  });
});

describe('пересборка «только рельеф»', () => {
  it('workflow читает terrain_only и пропускает горизонтали, OSM, вектор, глифы', () => {
    expect(WF).toMatch(/terrain_only=\$\{TERRAIN_ONLY:-false\}/);
    const gated = (WF.match(/if: \$\{\{ (?:always\(\) && )?steps\.cfg\.outputs\.terrain_only != 'true' \}\}/g) ?? []).length;
    expect(gated).toBeGreaterThanOrEqual(6);
    expect(WF).toMatch(/\.terrain\.pmtiles" --terrain-only/);
  });

  it('заливка с --terrain-only кладёт один файл и не трогает остального', () => {
    expect(UP).toMatch(/const terrainOnly = process\.argv\.includes\('--terrain-only'\)/);
    expect(UP).toMatch(/только рельеф: горизонтали, OSM, вектор, глифы и паспорт не трогались/);
  });
});
