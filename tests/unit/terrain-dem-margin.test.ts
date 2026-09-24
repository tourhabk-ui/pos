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

describe('мозаика на стыке широтных полос (24.09)', () => {
  // Запас DEM тянет клетки соседней полосы, а у Copernicus шаг по долготе
  // меняется на 50° и 60°. Шаг первой клетки на всю мозаику сжимал градус
  // чужой полосы — у мыса Лопатка пропал кончик полуострова.
  const FIX = PY.slice(PY.indexOf('def build_mosaic('), PY.indexOf('def sample_bilinear('));

  it('шаг сетки — самый мелкий из клеток, не шаг первой', () => {
    expect(FIX).toMatch(/res_x = rx if res_x is None else min\(res_x, rx\)/);
    expect(FIX).not.toMatch(/with rasterio\.open\(paths\[0\]\) as s0:/);
  });

  it('каждая клетка пересчитывается на общую сетку по своему шагу', () => {
    expect(FIX).toMatch(/src_rx, src_ry = src\.res/);
    expect(FIX).toMatch(/a = a\[np\.ix_\(ys, xs\)\]/);
  });

  it('самотест мозаики стоит в сборке ДО рельефа и валит её при отказе', () => {
    const test = WF.indexOf('python3 scripts/map-tiles/check_mosaic_bands.py');
    const terrain = WF.indexOf('scripts/map-tiles/build_terrain.py');
    expect(test).toBeGreaterThan(-1);
    expect(test).toBeLessThan(terrain);
    const selfTest = readFileSync(join(ROOT, 'scripts/map-tiles/check_mosaic_bands.py'), 'utf-8');
    expect(selfTest).toMatch(/return 1/);
    // Оба стыка и оба порядка чтения — иначе сторож прошёл бы на удачном порядке.
    expect(selfTest).toMatch(/мелкая первой/);
    expect(selfTest).toMatch(/крупная первой/);
    expect(selfTest).toMatch(/'59-60'/);
  });
});

describe('пересборка рельефа списком (24.09)', () => {
  // Клетки, собранные до починки мозаики, пересобираются только рельефом:
  // тем же сборщиком, с тем же самотестом, одним файлом на клетку.
  const RB = readFileSync(join(ROOT, '.github/workflows/map-terrain-rebuild.yml'), 'utf-8');
  const MARK = JSON.parse(readFileSync(join(ROOT, '.github/triggers/map-terrain-rebuild.json'), 'utf-8')) as {
    regions?: unknown; upload?: unknown;
  };

  it('самотест мозаики — до сборки', () => {
    // По командам запуска, не по словам: шапка файла называет оба скрипта.
    const test = RB.indexOf('python3 scripts/map-tiles/check_mosaic_bands.py');
    const build = RB.indexOf('python3 scripts/map-tiles/build_terrain.py');
    expect(test).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(test).toBeLessThan(build);
  });

  it('заливка — только рельеф, остального в хранилище не трогает', () => {
    expect(RB).toMatch(/upload-pack\.ts "\$R" "\.cache\/packs\/\$R\.terrain\.pmtiles" --terrain-only/);
  });

  it('bbox — из реестра, а не из маркера', () => {
    expect(RB).toMatch(/region-bbox\.ts "\$R"/);
  });

  it('ноль готовых или любой отказ красит прогон', () => {
    expect(RB).toMatch(/\[ -z "\$failed" \] && \[ "\$ok" -eq "\$TOTAL" \]/);
  });

  it('сводка не красит удачный прогон: под bash -e ложная проверка роняет шаг', () => {
    // Прогон 1 (24.09) покраснел после «готово: 18 из 18» на строке
    // «[ -n "$failed" ] && echo»: при пустом списке она возвращает ложь.
    const code = RB.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/\[ -n "\$failed" \] &&/);
    expect(code).toMatch(/if \[ -n "\$failed" \]; then echo/);
  });

  it('маркер просит только собранные клетки', async () => {
    const { BUILT_GRID_CELLS } = await import('@/lib/map/pack-source');
    expect(Array.isArray(MARK.regions)).toBe(true);
    for (const r of MARK.regions as string[]) expect(BUILT_GRID_CELLS as readonly string[], r).toContain(r);
  });
});

