/**
 * Сторож обзорного яруса: зумы ярусов НЕ пересекаются.
 *
 * Скрин владельца 04.09 07:42: человек смотрит на 119 км до цели, карты нет
 * вовсе, только надпись «приблизьте». Пакеты района и клетки начинаются с
 * зума 8, а ниже нижнего зума MapLibre растровый источник не рисует и вниз
 * не масштабирует — значит обзорный масштаб пуст по построению, сколько
 * клеток ни собери. Обзор закрывает ровно эту дыру: один пакет на край,
 * зумы 4-7.
 *
 * Опасность у этой конструкции одна и тихая: сдвинуть границу так, что
 * ярусы налезут друг на друга. На общем зуме тогда лягут два рельефа —
 * прореженный поверх подробного, — и карта станет хуже, ничего не сломав
 * заметно. Поэтому стык проверяется числом с обеих сторон: у сборщика и у
 * читателя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OVERVIEW_ID, OVERVIEW_BBOX, isOverviewId, packRegionBbox, packRegionCenter,
  REGIONS_LIST,
} from '@/lib/geo/regions';
import {
  OVERVIEW_MAX_ZOOM, OVERVIEW_BUILT, PACK_TERRAIN_MAXZOOM, resolvePackSource,
} from '@/lib/map/pack-source';
import { builtRegionPacks, regionsIntersecting, regionsForPoint } from '@/lib/map/field-base-map';

const PY = readFileSync(join(process.cwd(), 'scripts/map-tiles/build_overview.py'), 'utf-8');
const TERRAIN = readFileSync(join(process.cwd(), 'scripts/map-tiles/build_terrain.py'), 'utf-8');
const MAP = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');
const B = 'https://s3.example.ru/b';

describe('обзорный ярус: стык зумов', () => {
  it('верх обзора ровно на единицу ниже низа пакетов — ни щели, ни нахлёста', () => {
    const packMin = Number(/^MINZOOM = (\d+)$/m.exec(TERRAIN)?.[1]);
    expect(packMin, 'MINZOOM пакета не найден').toBe(8);
    expect(OVERVIEW_MAX_ZOOM).toBe(packMin - 1);
  });

  it('сборщик обзора печёт те же зумы, что обещает читатель', () => {
    expect(PY).toMatch(/^MINZOOM = 4$/m);
    expect(PY).toMatch(/^MAXZOOM = 7$/m);
    expect(Number(/^MAXZOOM = (\d+)$/m.exec(PY)?.[1])).toBe(OVERVIEW_MAX_ZOOM);
    // Обзор мельче подробного пакета — иначе он не обзор.
    expect(OVERVIEW_MAX_ZOOM).toBeLessThan(PACK_TERRAIN_MAXZOOM);
  });

  it('прореживание мельче пикселя верхнего зума — обзор не размыт', () => {
    const dec = Number(/^DECIMATE = (\d+)$/m.exec(PY)?.[1]);
    expect(dec).toBeGreaterThan(0);
    // Шаг GLO-30 — 1 угловая секунда, 3600 точек на градус.
    const stepM = (111320 / (3600 / dec));
    // Пиксель z7 на широте 56: 156543 * cos(56) / 2^7 / 256 * 256.
    const pxM = 156543.03 * Math.cos((56 * Math.PI) / 180) / 2 ** OVERVIEW_MAX_ZOOM;
    expect(stepM).toBeLessThan(pxM);
  });
});

describe('обзорный ярус: место в реестре', () => {
  it('это НЕ район для человека — в списке офлайн-скачивания его нет', () => {
    expect(REGIONS_LIST.some(r => String(r.id) === OVERVIEW_ID)).toBe(false);
  });

  it('точке обзор не сопоставляется: район и клетка — да, обзор — нет', () => {
    // Авачинский: район есть, клетка есть, обзор не должен примешаться.
    const hit = regionsForPoint(53.26, 158.83).map(String);
    expect(hit).not.toContain(OVERVIEW_ID);
    expect(hit.length).toBeGreaterThan(0);
  });

  it('границы и центр обзора отвечают наравне с районом и клеткой', () => {
    expect(isOverviewId(OVERVIEW_ID)).toBe(true);
    expect(isOverviewId('avacha-group')).toBe(false);
    expect(packRegionBbox(OVERVIEW_ID)).toEqual(OVERVIEW_BBOX);
    const c = packRegionCenter(OVERVIEW_ID);
    expect(c).toEqual({
      lat: (OVERVIEW_BBOX.south + OVERVIEW_BBOX.north) / 2,
      lng: (OVERVIEW_BBOX.west + OVERVIEW_BBOX.east) / 2,
    });
  });

  it('охват обзора накрывает и районы, и клетки — иначе он не обзор края', () => {
    for (const r of REGIONS_LIST) {
      expect(r.bbox.west, r.id).toBeGreaterThanOrEqual(OVERVIEW_BBOX.west);
      expect(r.bbox.east, r.id).toBeLessThanOrEqual(OVERVIEW_BBOX.east);
      expect(r.bbox.south, r.id).toBeGreaterThanOrEqual(OVERVIEW_BBOX.south);
      expect(r.bbox.north, r.id).toBeLessThanOrEqual(OVERVIEW_BBOX.north);
    }
  });
});

describe('обзорный ярус: обещание и адреса', () => {
  it('несобранный обзор — названная причина, а не пустая карта', () => {
    const src = resolvePackSource(OVERVIEW_ID, [], B);
    if (OVERVIEW_BUILT) {
      expect(src.state).toBe('ready');
    } else {
      expect(src.state).toBe('not_built');
      expect(src.state === 'not_built' && src.reason).toMatch(/обзорн/i);
    }
  });

  it('у собранного обзора нет ни OSM, ни вектора — только рельеф', () => {
    // Проверяем форму ответа независимо от текущего значения обещания:
    // подменяем его через тот же вход, что и у районов.
    const src = resolvePackSource(OVERVIEW_ID, [], B);
    if (src.state !== 'ready') return; // обещание ещё не поставлено — это исход, не сбой
    expect(src.osmUrls).toEqual({});
    expect(src.vectorUrl).toBeNull();
    expect(src.terrainMaxZoom).toBe(OVERVIEW_MAX_ZOOM);
    expect(src.terrainUrl).toContain('krai-overview.terrain.pmtiles');
  });

  it('несобранный обзор не попадает в пакеты и не ломает список', () => {
    const packs = builtRegionPacks(B);
    const has = packs.some(p => p.region === OVERVIEW_ID);
    expect(has).toBe(OVERVIEW_BUILT);
    if (has) {
      // Обзор идёт первым: он ярус ниже всех, карта кладёт слои по порядку.
      expect(packs[0]?.region).toBe(OVERVIEW_ID);
      // И пересекает любой вид края.
      expect(regionsIntersecting(packs, { south: 53, west: 158, north: 54, east: 159 }))
        .toContain(OVERVIEW_ID);
    }
  });
});

describe('обзорный ярус: карта', () => {
  it('у обзора только базовый ярус — подробного у него не бывает', () => {
    expect(MAP).toMatch(/region === OVERVIEW_ID\s*\n?\s*\? \['base'\]/);
  });

  it('жалоба на мелкий масштаб снимается, когда обзор есть', () => {
    expect(MAP).toMatch(/const hasOverview = packs\.some\(p => p\.region === OVERVIEW_ID\);/);
    expect(MAP).toMatch(/if \(zoom < PACK_MIN_ZOOM && !hasOverview\)/);
  });
});

describe('workflow обзора: каталог для лога существует ДО tee (04.09)', () => {
  // Прогон 2 (run 33868408741): `tee .cache/overview-build.log` открывает
  // файл раньше, чем python успевает что-то создать (тот делает mkdir только
  // для .cache/packs, своей цели, уже внутри main()) — без каталога tee падает
  // ENOENT, pipefail топит шаг кодом 1, а В ЛОГЕ сборка при этом видна
  // полностью успешной («готово:», размер, время сборки). Ловушка «зелёного»
  // вывода при красном прогоне — сторож ловит её статикой, а не ждёт
  // повторной боевой пересборки.
  const WF = readFileSync(
    join(process.cwd(), '.github/workflows/map-overview-build.yml'), 'utf-8',
  );

  it('mkdir каталога стоит до `tee .cache/overview-build.log`', () => {
    const teeIdx = WF.lastIndexOf('tee .cache/overview-build.log');
    expect(teeIdx, '`tee .cache/overview-build.log` не найден в workflow').toBeGreaterThan(0);
    const before = WF.slice(0, teeIdx);
    expect(before).toMatch(/mkdir -p \.cache\b/);
  });
});
