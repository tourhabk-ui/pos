/**
 * Удаление офлайн-карты действительно освобождает место — и только своё.
 *
 * До 22.08.2026 «Удалить регион» не освобождало ничего. Кнопка снимала
 * метаданные и маршруты (килобайты) и слала service worker'у команду, чей
 * обработчик НЕ УДАЛЯЛ НИЧЕГО — он отвечал «готово». Тайлы (6-22 МБ на
 * регион) оставались навсегда: LRU-эвикция в service worker есть для страниц
 * мест, туров и поездок, для тайлов её нет вовсе.
 *
 * Полевой пакет удалить было нельзя вообще: `removeFieldPack` не звалась
 * ниоткуда, а её тайлы коридора не снимал никто.
 *
 * Цена — не только место. При исчерпании квоты браузер выбрасывает хранилище
 * источника ЦЕЛИКОМ, вместе с офлайн-маршрутами и полевыми пакетами: мусор
 * отнимает карту у того, кто собрался в поход.
 *
 * Ошибка в обратную сторону дороже: удалить тайл, который держит соседний
 * регион или пакет, значит проделать дыру в чужой карте — и обнаружится она
 * в поле. Поэтому проверяется обе стороны.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { planTileRelease, estimateReleaseMb, regionTileUrls, type TileHolder } from '@/lib/offline/tile-ownership';
import { REGIONS_LIST } from '@/lib/geo/regions';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

const h = (id: string, urls: string[]): TileHolder => ({ id, urls });

describe('расчёт освобождаемых тайлов', () => {
  it('одинокий владелец отдаёт всё', () => {
    expect(planTileRelease(h('a', ['u1', 'u2']), [])).toEqual({ release: ['u1', 'u2'], kept: 0 });
  });

  it('тайл, который держит кто-то ещё, не удаляется', () => {
    const plan = planTileRelease(h('a', ['общий', 'свой']), [h('b', ['общий'])]);
    expect(plan.release).toEqual(['свой']);
    expect(plan.kept).toBe(1);
  });

  it('сам себя владелец не удерживает', () => {
    // Иначе удалять было бы нечего никогда: список остающихся приходит целиком.
    const plan = planTileRelease(h('a', ['u1']), [h('a', ['u1']), h('b', [])]);
    expect(plan.release).toEqual(['u1']);
  });

  it('повторяющийся адрес решается один раз', () => {
    const plan = planTileRelease(h('a', ['u1', 'u1', 'u2']), []);
    expect(plan.release).toEqual(['u1', 'u2']);
  });

  it('пакет внутри региона не отнимает карту у региона', () => {
    // Коридор маршрута лежит внутри bbox региона: адреса пересекаются.
    const region = h('region:r', ['t1', 't2', 't3']);
    const pack = h('pack:p', ['t2']);
    expect(planTileRelease(pack, [region]).release).toEqual([]);
    expect(planTileRelease(region, [pack]).release).toEqual(['t1', 't3']);
  });
});

describe('оценка освобождаемого объёма', () => {
  it('считает по зуму из адреса', () => {
    // .../{z}/{x}/{y}.png — детальные тайлы весят больше.
    const coarse = estimateReleaseMb(Array.from({ length: 200 }, (_, i) => `https://tile/7/${i}/1.png`));
    const fine = estimateReleaseMb(Array.from({ length: 200 }, (_, i) => `https://tile/12/${i}/1.png`));
    expect(fine).toBeGreaterThan(coarse);
  });

  it('пустой список — ноль, а не выдуманное число', () => {
    expect(estimateReleaseMb([])).toBe(0);
  });
});

describe('адреса регионов вычислимы', () => {
  it('у каждого региона реестра адреса считаются', () => {
    for (const r of REGIONS_LIST) {
      expect(regionTileUrls(r.id).length, r.id).toBeGreaterThan(0);
    }
  });

  it('неизвестный регион даёт пустой список, а не бросает', () => {
    // Пустой список НИЧЕГО не разрешает удалить — безопасная сторона ошибки.
    expect(regionTileUrls('нет-такого' as never)).toEqual([]);
  });

  it('соседние регионы делят тайлы — значит проверка перекрытия не теоретическая', () => {
    const all = REGIONS_LIST.map(r => new Set(regionTileUrls(r.id)));
    let overlaps = 0;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if ([...all[i]].some(u => all[j].has(u))) overlaps++;
      }
    }
    expect(overlaps).toBeGreaterThan(0);
  });
});

describe('service worker действительно удаляет', () => {
  const sw = read('public/sw.js');
  // Без комментариев: в шапке обработчика описана прежняя ошибка, и проверка
  // ниже поймала бы собственное пояснение вместо кода.
  const swCode = sw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

  it('обработчик, отвечавший «готово» без удаления, не вернулся', () => {
    expect(swCode).not.toMatch(/CLEAR_REGION_TILES/);
  });

  it('удаление идёт по списку адресов и зовёт cache.delete', () => {
    expect(swCode).toMatch(/CLEAR_TILES/);
    const fn = swCode.slice(swCode.indexOf('async function deleteTiles'));
    expect(fn.slice(0, 1400)).toMatch(/cache\.delete\(/);
  });

  it('докладывается число РЕАЛЬНО удалённых, а не длина списка', () => {
    // Адрес мог никогда не кэшироваться: выдать намерение за результат — это
    // ровно та ошибка, на которой обработчик погорел в прошлый раз.
    const fn = swCode.slice(swCode.indexOf('async function deleteTiles'), swCode.indexOf('async function cacheTilesForRegion'));
    expect(fn).toMatch(/if \(await cache\.delete\(url\)\) deleted\+\+/);
  });

  it('отказ открыть кэш не выдаётся за успешную очистку', () => {
    const fn = swCode.slice(swCode.indexOf('async function deleteTiles'), swCode.indexOf('async function cacheTilesForRegion'));
    expect(fn).toMatch(/ok: false/);
  });
});

describe('удаление подключено к обоим хранителям', () => {
  it('удаление региона считает и отдаёт адреса', () => {
    const src = code('lib/offline/useOfflineRegion.ts');
    expect(src).toMatch(/\bplanTileRelease\b/);
    expect(src).toMatch(/CLEAR_TILES/);
  });

  it('удаление региона учитывает и полевые пакеты, а не только соседние регионы', () => {
    expect(code('lib/offline/useOfflineRegion.ts')).toMatch(/\blistFieldPackRecords\b/);
  });

  it('полевой пакет снимается вместе со своей картой', () => {
    const src = code('lib/offline/field-pack.ts');
    expect(src).toMatch(/\bplanTileRelease\b/);
    expect(src).toMatch(/CLEAR_TILES/);
  });

  it('у пакета есть кнопка удаления', () => {
    expect(code('app/planning/_PlanningClient.tsx')).toMatch(/\bremoveFieldPack\b/);
  });

  it('несостоявшаяся очистка не выдаётся за освобождённое место', () => {
    expect(read('lib/offline/field-pack.ts')).toMatch(/тайлы пакета не удалены/);
    expect(read('lib/offline/useOfflineRegion.ts')).toMatch(/тайлы региона не удалены/);
  });
});

describe('состав региона проверяется делом', () => {
  it('число сохранённых маршрутов сверяется с записанным', () => {
    const src = code('lib/offline/useOfflineRegion.ts');
    expect(src).toMatch(/\bgetRoutesByRegion\b/);
    expect(src).toMatch(/routesShort/);
  });

  it('удаление маршрутов региона не продублировано в двух местах', () => {
    const src = code('lib/offline/db.ts');
    const del = src.slice(src.indexOf('export async function deleteRegion'));
    expect(del.slice(0, 400)).toMatch(/deleteRoutesByRegion\(id\)/);
  });
});
