/**
 * lib/map/field-base-map.ts — какая подложка под полевым экраном.
 *
 * Проба своей карты (31.08) подключается ТОЛЬКО там, где для района есть
 * собранный пакет. Во всех остальных случаях остаётся Leaflet — тот же, что
 * на девяти поверхностях сегодня. Это не осторожность ради осторожности:
 * решение о миграции владелец принимает по фактам пробы, а до тех пор
 * человек в поле не должен потерять карту из-за нашего эксперимента.
 *
 * Отсюда правило выбора: своя карта включается по НАЛИЧИЮ пакета, а не по
 * флагу «мы уже переехали». Пакета нет — Leaflet, и это не деградация, а
 * штатный путь.
 */

import { REGIONS, REGIONS_LIST, type RegionId } from '@/lib/geo/regions';
import {
  resolvePackSource, BUILT_PACK_REGIONS, type PackSource,
} from '@/lib/map/pack-source';

/**
 * Район, накрывающий точку. Первый подходящий по bbox — регионы реестра
 * перекрываются (Налычево заходит на Авачинскую группу), и разбирать это
 * «умно» здесь нельзя: любой выбор был бы догадкой, а пакеты всё равно
 * покрывают оба bbox целиком.
 */
export function regionsForPoint(lat: number, lng: number): RegionId[] {
  return REGIONS_LIST
    .filter(r => lat >= r.bbox.south && lat <= r.bbox.north
      && lng >= r.bbox.west && lng <= r.bbox.east)
    .map(r => r.id);
}

/** Первый накрывающий район — для показа и для обратной совместимости. */
export function regionForPoint(lat: number, lng: number): RegionId | null {
  return regionsForPoint(lat, lng)[0] ?? null;
}

export type FieldBaseMap =
  /** Своя карта: пакет района на месте. */
  | { kind: 'vedar'; region: RegionId; source: Extract<PackSource, { state: 'ready' }> }
  /** Leaflet — и названная причина, почему не своя. Причина не показывается
   *  человеку (карта работает), но должна быть видна в разборе. */
  | { kind: 'leaflet'; reason: string };

/**
 * Выбор подложки для точки. Чистая функция — проверяется тестом целиком.
 */
export function chooseFieldBaseMap(
  lat: number,
  lng: number,
  /**
   * Адрес хранилища пакетов. Приходит СВЕРХУ, с сервера: `NEXT_PUBLIC_*`
   * подставляется при сборке, а сборка у нас идёт внутри образа, куда
   * переменные приложения Timeweb не попадают (разбор 01.09 — см. шапку
   * lib/map/pack-source.ts).
   */
  baseUrl: string | null,
  builtRegions: readonly RegionId[] = BUILT_PACK_REGIONS,
): FieldBaseMap {
  const candidates = regionsForPoint(lat, lng);
  if (candidates.length === 0) {
    return { kind: 'leaflet', reason: 'Точка вне районов реестра — пакета быть не может.' };
  }

  /**
   * Берём ЛЮБОЙ накрывающий район, у которого пакет собран, а не первый по
   * списку. Замер 01.09: аэропорт Елизово попал в `avacha-group`, а сам город
   * в шести километрах — в `paratunka`, потому что прямоугольники реестра
   * перекрываются и проведены «на глаз» (в самом реестре записано:
   * «координаты bbox приближённые»).
   *
   * Со старой логикой человек, проехавший из аэропорта в город, терял
   * подложку на ровном месте — хотя пакет `avacha-group` физически покрывает
   * оба места. Первый попавшийся район — это ответ о ПОРЯДКЕ В СПИСКЕ, а
   * вопрос был о том, есть ли на эту точку карта.
   */
  for (const region of candidates) {
    const source = resolvePackSource(region, builtRegions, baseUrl);
    if (source.state === 'ready') return { kind: 'vedar', region, source };
  }

  // Ни у одного накрывающего района пакета нет. Причину берём у первого —
  // они различаются только именем района, а состояние у всех одно.
  const first = resolvePackSource(candidates[0], builtRegions, baseUrl);
  return {
    kind: 'leaflet',
    reason: candidates.length > 1
      ? `${'reason' in first ? first.reason : 'Пакета нет.'} Районов на эту точку: ${candidates.length}.`
      : ('reason' in first ? first.reason : 'Пакета нет.'),
  };
}

/** Центр района — начальный вид своей карты, когда фикса ещё нет. */
export function regionCenter(region: RegionId): [number, number] {
  const c = REGIONS[region].center;
  return [c.lat, c.lng];
}
