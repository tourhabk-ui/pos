/**
 * Снимки пакетов карты на раннере (05.09).
 *
 * Сторож держит то, что разъедется молча: снимок должен идти ТЕМ ЖЕ стилем,
 * что карта в поле (иначе он ничего не доказывает); у кадра три исхода, а не
 * два; маркер просит только пакеты из реестра собранных; workflow зовёт
 * именно этот скрипт и кладёт кадры артефактом даже при красном шаге.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zoomsFor, centerFor, snapshotTargets, parseViews, viewFrameName } from '@/scripts/map-tiles/snapshot-packs';
import { OVERVIEW_ID } from '@/lib/geo/regions';
import { gridCellById } from '@/lib/geo/grid-cells';

const ROOT = process.cwd();
const SCRIPT = readFileSync(join(ROOT, 'scripts/map-tiles/snapshot-packs.ts'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/map-pack-snapshot.yml'), 'utf-8');
const MARKER = JSON.parse(readFileSync(join(ROOT, '.github/triggers/map-pack-snapshot.json'), 'utf-8')) as {
  packs?: unknown; theme?: unknown; views?: unknown;
};

describe('снимок — тем же стилем, что карта в поле', () => {
  it('стиль строится buildVedarStyle из resolvePackSource, своей копии нет', () => {
    expect(SCRIPT).toMatch(/import \{\s*buildVedarStyle[^}]*\} from '@\/lib\/map\/vedar-style'/);
    // Соседи в кадре — тем же правилом, что у VedarMap: подкладки по
    // пересечению с кадром, ярус detail с DETAIL_MIN_ZOOM, углы клеток.
    expect(SCRIPT).toMatch(/regionsIntersecting\(allPacks, view\)/);
    expect(SCRIPT).toMatch(/f\.zoom >= DETAIL_MIN_ZOOM \? \['base', 'detail'\] : \['base'\]/);
    expect(SCRIPT).toMatch(/\$\{pack\}\.corner\.z\$\{zoom\}/);
    expect(SCRIPT).toMatch(/resolvePackSource\(pack as PackRegionId, BUILT_PACK_REGIONS, proxyBase\)/);
    expect(SCRIPT).toMatch(/oceanUrl: src\.oceanUrl/);
    expect(SCRIPT).toMatch(/placesUrl: src\.placesUrl/);
    expect(SCRIPT).toMatch(/vectorUrl: src\.vectorUrl/);
    // Единственный «свой» стиль — проба WebGL из одного фона, без источников.
    expect(SCRIPT.match(/version: 8/g)?.length).toBe(1);
  });

  it('файлы бакета идут через локальный прокси (CORS бакета — только для сайта), с Range и кодом как есть', () => {
    expect(SCRIPT).toMatch(/const proxyBase = `\$\{origin\}\/bucket`/);
    expect(SCRIPT).toMatch(/if \(typeof range === 'string'\) headers\.range = range/);
    expect(SCRIPT).toMatch(/res\.writeHead\(upstream\.status, out\)/);
    expect(SCRIPT).toMatch(/'content-range'/);
    expect(SCRIPT).toMatch(/запросов к бакету через прокси/);
  });

  it('кадры уходят JPEG в ветку map-snapshots — чтобы смотреть глазами, не только «idle без ошибок»', () => {
    expect(SCRIPT).toMatch(/type: 'jpeg'/);
    expect(WF).toMatch(/HEAD:refs\/heads\/map-snapshots/);
    expect(WF).toMatch(/contents: write/);
    expect(SCRIPT).toMatch(/--force-ocean/);
    expect(WF).toContain('--force-ocean');
  });

  it('pmtiles-протокол зарегистрирован через обёртку, считающую «нет в каталоге»; буфер кадра сохраняется', () => {
    // Обёртка зовёт ТОТ ЖЕ protocol.tile, что и карта в поле, и лишь
    // записывает пустые ответы: из пустого буфера MapLibre делает «could not
    // be decoded», и без этого списка «нет тайла» не отличить от «битый».
    expect(SCRIPT).toMatch(/maplibregl\.addProtocol\('pmtiles', async \(params, ctrl\) => \{\s*const r = await protocol\.tile\(params, ctrl\)/);
    expect(SCRIPT).toMatch(/state\.missing\.push/);
    expect(SCRIPT).toMatch(/preserveDrawingBuffer: true/);
    // Сводка состояний тайлов рельефа — в каждом кадре, не только при отказе.
    expect(SCRIPT).toMatch(/const tiles = await tileDump\(page\)/);
    expect(SCRIPT).toMatch(/\| тайлы рельефа \|/);
  });
});

describe('исходы', () => {
  it('у кадра три исхода, у прогона — четвёртый (нет WebGL)', () => {
    expect(SCRIPT).toMatch(/export type ShotVerdict = 'ok' \| 'broken' \| 'timeout'/);
    expect(SCRIPT).toMatch(/outcome: 'no_webgl'/);
    expect(SCRIPT).toMatch(/return broken \? 1 : timeout \? 3 : 0/);
  });

  it('workflow различает коды 1/2/3 и кладёт артефакт всегда', () => {
    expect(WF).toContain('scripts/map-tiles/snapshot-packs.ts');
    expect(WF).toMatch(/if \[ "\$code" = "1" \]/);
    expect(WF).toMatch(/elif \[ "\$code" = "3" \]/);
    expect(WF).toMatch(/elif \[ "\$code" = "2" \]/);
    // Мажор действия НЕ закрепляем: сторож про то, что артефакт кладётся
    // ВСЕГДА, а не про версию upload-artifact. Закреплённый `@v4` покраснел
    // на подъёме группы actions до v7 (#1716) — по причине, к предмету
    // проверки не относящейся, и уронил main вместе с деплоем. Ровно тот
    // случай, что записан в §7: замороженное число в правиле устаревает
    // молча и учит не доверять правилу целиком.
    expect(WF).toMatch(/upload-artifact@v\d+\n\s+if: always\(\)/);
    expect(WF).toContain('.github/triggers/map-pack-snapshot.json');
  });
});

describe('план кадров', () => {
  it('обзор — на своих зумах z4-7, с нижнего края; пакеты — на z8-13', () => {
    expect(zoomsFor(OVERVIEW_ID)).toContain(4);
    expect(zoomsFor(OVERVIEW_ID).every((z) => z >= 4 && z <= 7)).toBe(true);
    expect(zoomsFor('cell-52n157e').every((z) => z >= 8 && z <= 13)).toBe(true);
    expect(zoomsFor('avacha-group').every((z) => z >= 8 && z <= 13)).toBe(true);
  });

  it('центр клетки — из реестра клеток; района и обзора — середина bbox', () => {
    expect(centerFor('cell-52n157e')).toEqual(gridCellById('cell-52n157e')?.center);
    const o = centerFor(OVERVIEW_ID);
    expect(o).not.toBeNull();
    expect(o!.lat).toBeGreaterThan(51); expect(o!.lat).toBeLessThan(65);
    expect(centerFor('no-such-pack')).toBeNull();
  });

  it('маркер просит только собранные пакеты и известную тему', () => {
    const all = new Set<string>(snapshotTargets());
    expect(Array.isArray(MARKER.packs)).toBe(true);
    for (const p of MARKER.packs as string[]) expect(all.has(p), p).toBe(true);
    expect(['dark', 'light']).toContain(MARKER.theme);
  });
});

describe('вид по жалобе — кадр ровно того места, что на скрине (24.09)', () => {
  // Центр обзора — на 58° с.ш.: юг края в его кадры не попадал никогда, и
  // жалоба владельца на юг Камчатки была непроверяема снимком. Вид — место
  // и зум со скрина, тем же стилем и теми же соседями, что у кадров пакета.
  it('вид читается как lat,lng,z и попадает в план того же пакета', () => {
    expect(parseViews('51.6,157.2,4.8;52,157.5,5.8')).toEqual([
      { lat: 51.6, lng: 157.2, zoom: 4.8 }, { lat: 52, lng: 157.5, zoom: 5.8 },
    ]);
    expect(viewFrameName(OVERVIEW_ID, { lat: 51.6, lng: 157.2, zoom: 4.8 })).toBe('krai-overview.view.51.60n157.20e.z4.8');
    expect(SCRIPT).toMatch(/for \(const v of views\) frames\.push/);
  });

  it('нечитаемый вид — отказ, а не молча пропущенный кадр', () => {
    expect(() => parseViews('51.6;157')).toThrow(/не читается/);
    expect(() => parseViews('95,157,5')).toThrow(/не читается/);
    expect(parseViews('')).toEqual([]);
  });

  it('workflow передаёт виды из маркера скрипту', () => {
    expect(WF).toMatch(/get\('views',\[\]\)/);
    expect(WF).toMatch(/--views \$\{\{ steps\.cfg\.outputs\.views \}\}/);
    if (MARKER.views !== undefined) {
      expect(Array.isArray(MARKER.views)).toBe(true);
      for (const v of MARKER.views as string[]) expect(() => parseViews(v), v).not.toThrow();
      // Пробелы в виде разбили бы аргумент на два при подстановке в FLAGS.
      for (const v of MARKER.views as string[]) expect(v, v).not.toMatch(/\s/);
    }
  });
});
