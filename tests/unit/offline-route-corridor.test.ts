/**
 * Коридор карты — обещание, которое сбудется в поле.
 *
 * Скачанная карта проверяется ровно один раз: когда связи уже нет. Значит
 * ошибиться здесь можно только заранее, и цена ошибки — дыра в карте на
 * маршруте. Тесты стерегут четыре вещи: коридор сплошной, он идёт по треку,
 * потолок режет детализацию а не ориентир, и обещанный вес не расходится с
 * тем, что скачается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  densify, corridorTileKeys, planCorridor,
  CORRIDOR_ZOOMS, CORRIDOR_BUFFER_KM, type TrackPoint,
} from '@/lib/offline/route-corridor';

const KM_LAT = 111.32;

/** Трек на восток от Петропавловска: n точек с шагом stepKm. */
function eastward(n: number, stepKm: number): TrackPoint[] {
  const kmLng = KM_LAT * Math.cos((53 * Math.PI) / 180);
  return Array.from({ length: n }, (_, i) => [53, 158.65 + (i * stepKm) / kmLng] as TrackPoint);
}

describe('коридор сплошной', () => {
  it('редкий трек уплотняется — иначе в карте дыра там, где идти легче всего', () => {
    // Трек приходит прореженным: между соседними точками бывают километры.
    const dense = densify(eastward(2, 10), 1);
    expect(dense.length).toBeGreaterThanOrEqual(11);
  });

  it('уплотнение не сдвигает концы маршрута', () => {
    const track = eastward(3, 7);
    const dense = densify(track, 1);
    expect(dense[0]).toEqual(track[0]);
    expect(dense[dense.length - 1][1]).toBeCloseTo(track[track.length - 1][1], 6);
  });

  it('вырожденный трек не ломает уплотнение', () => {
    expect(densify([], 1)).toEqual([]);
    expect(densify([[53, 158]], 1)).toEqual([[53, 158]]);
  });

  it('в коридоре нет разрывов по X на длинном прямом участке', () => {
    // Дыра — это пропущенный столбец тайлов посередине маршрута.
    const keys = corridorTileKeys(eastward(2, 30), 14);
    const xs = [...new Set(keys.map(k => Number(k.split('/')[1])))].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBe(1);
  });
});

describe('коридор идёт по треку, а не вокруг прямоугольника', () => {
  it('крюк не приводит к скачиванию всего прямоугольника', () => {
    // Маршрут «вверх и вправо»: прямоугольник накрыл бы и пустой угол.
    const kmLng = KM_LAT * Math.cos((53 * Math.PI) / 180);
    const corner: TrackPoint[] = [
      [53, 158.65],
      [53 + 20 / KM_LAT, 158.65],
      [53 + 20 / KM_LAT, 158.65 + 20 / kmLng],
    ];
    const corridor = new Set(corridorTileKeys(corner, 13));
    // Противоположный угол прямоугольника — там, где человек не был.
    const away = corridorTileKeys([[53, 158.65 + 20 / kmLng]], 13);
    expect(away.some(k => corridor.has(k))).toBe(false);
  });

  it('ширина коридора слушается буфера', () => {
    const narrow = corridorTileKeys(eastward(5, 2), 14, 0.5).length;
    const wide = corridorTileKeys(eastward(5, 2), 14, 4).length;
    expect(wide).toBeGreaterThan(narrow);
  });

  it('пустой трек не даёт ни одного тайла', () => {
    expect(corridorTileKeys([], 14)).toEqual([]);
    expect(planCorridor([]).tiles).toBe(0);
  });
});

describe('потолок режет детализацию, а не ориентир', () => {
  const long = eastward(2, 40);

  it('самый грубый зум входит всегда, даже если бюджет мал', () => {
    // Карта без грубого слоя бесполезна целиком: человек не понимает, где он
    // относительно посёлка и дороги. Без детального — просто не видит тропу.
    const plan = planCorridor(long, { maxMb: 1 });
    expect(plan.zooms).toEqual([CORRIDOR_ZOOMS[0]]);
    expect(plan.tiles).toBeGreaterThan(0);
  });

  it('отброшенные зумы названы, а не срезаны молча', () => {
    const plan = planCorridor(long, { maxMb: 1 });
    expect(plan.droppedZooms.length).toBeGreaterThan(0);
    // Отбрасываются именно детальные.
    expect(Math.min(...plan.droppedZooms)).toBeGreaterThan(Math.max(...plan.zooms));
  });

  it('щедрый бюджет берёт все зумы и ничего не отбрасывает', () => {
    const plan = planCorridor(eastward(5, 2), { maxMb: 500 });
    expect(plan.zooms).toEqual(CORRIDOR_ZOOMS);
    expect(plan.droppedZooms).toEqual([]);
  });

  it('обещанный вес не меньше того, что скачается', () => {
    // Пообещать 5 МБ и выкачать 40 — это обман в единственный момент, когда
    // человек решает, ждать ему или выходить.
    const plan = planCorridor(eastward(10, 3), { maxMb: 500 });
    const worstMb = (plan.tiles * 25) / 1024;
    expect(plan.estimateMb).toBeGreaterThanOrEqual(Math.floor(worstMb * 0.7));
    expect(plan.estimateMb).toBeLessThanOrEqual(500);
  });
});

describe('размер по-человечески', () => {
  it('дневной маршрут укладывается в десятки мегабайт, а не сотни', () => {
    // Двадцать километров — обычный однодневный выход.
    const plan = planCorridor(eastward(2, 20));
    expect(plan.estimateMb).toBeLessThan(40);
    expect(plan.tiles).toBeGreaterThan(50);
  });

  it('тайлы не повторяются: платить дважды за один квадрат нельзя', () => {
    const plan = planCorridor(eastward(20, 1));
    expect(new Set(plan.urls).size).toBe(plan.urls.length);
  });

  it('буфер по умолчанию — пара километров в каждую сторону', () => {
    expect(CORRIDOR_BUFFER_KM).toBeGreaterThanOrEqual(1);
    expect(CORRIDOR_BUFFER_KM).toBeLessThanOrEqual(3);
  });
});

describe('офлайн-пакет маршрута пользуется коридором', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/api/routes/[id]/offline-bundle/route.ts'), 'utf-8');

  it('трек берётся из geometry, а не из одних точек', () => {
    expect(SRC).toMatch(/geometry/);
    expect(SRC).toMatch(/planCorridor\(track\)/);
  });

  it('прямоугольник остался только запасным вариантом', () => {
    // Для точки-сущности (гора, озеро) трека нет, и квадрат вокруг координаты
    // честен. Для маршрута с треком он качал не ту карту.
    expect(SRC).toMatch(/track\.length >= 2 \? planCorridor\(track\) : null/);
    expect(SRC).toMatch(/corridor\s*\n?\s*\? corridor\.urls/);
  });

  it('ответ называет покрытие, вес и отброшенные зумы', () => {
    // Молчаливый срез — это карта, на которую человек рассчитывал и которой
    // не будет. Он узнает об этом в поле.
    expect(SRC).toMatch(/tile_coverage/);
    expect(SRC).toMatch(/estimate_mb/);
    expect(SRC).toMatch(/dropped_zooms/);
    expect(SRC).toMatch(/corridor_buffer_km/);
  });
});
