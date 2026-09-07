/**
 * lib/map/pack-manifest.ts — паспорт пакета карты: сколько чего внутри.
 *
 * Зачем (05.09). Проверка хранилища после 112 клеток показала: у корякских
 * клеток слои OSM «тропы/дороги/приюты» — по нулю объектов, в OSM там пусто.
 * Карта при этом молчала: рельеф есть, линий нет, и человек в поле не мог
 * отличить «данных нет» от «слой не пришёл» — а это разные беды (§4.0), и
 * решение по ним разное: одну ждут и повторяют, с другой идут по рельефу.
 *
 * Паспорт — маленький JSON рядом с пакетом (`<region>.manifest.json`): число
 * объектов по каждому слою OSM, снятое с тех же файлов, что залиты. Пишет его
 * заливка пакета (upload-pack.ts) и разовая перепись уже залитых
 * (build-manifests.ts). Карта читает паспорт и ГОВОРИТ словами, чего в
 * пакете нет. Нет паспорта — карта молчит: «не знаю» — не то же, что «пусто».
 */

import { OSM_LAYERS, type OsmLayer } from '@/lib/map/pack-source';

export const PACK_MANIFEST_V = 1;

export interface PackManifest {
  v: number;
  region: string;
  built_at: string;
  /** Объектов в каждом слое OSM. Отсутствующий слой — «не считали», не ноль. */
  osm: Partial<Record<OsmLayer, number>>;
}

export function buildPackManifest(
  region: string, osm: Partial<Record<OsmLayer, number>>, builtAt = new Date().toISOString(),
): PackManifest {
  return { v: PACK_MANIFEST_V, region, built_at: builtAt, osm };
}

/**
 * Число объектов коллекции GeoJSON. Отказ разбора — null («не знаю»), а не
 * ноль: испорченный файл не должен выглядеть как честно пустой слой.
 */
export function countGeoJsonFeatures(text: string): number | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const feats = (parsed as { features?: unknown }).features;
    return Array.isArray(feats) ? feats.length : null;
  } catch {
    return null;
  }
}

/** Разбор паспорта из сети/кэша. Не паспорт — null, без исключений. */
export function parsePackManifest(input: unknown): PackManifest | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (typeof o.v !== 'number' || typeof o.region !== 'string' || typeof o.built_at !== 'string') return null;
  if (!o.osm || typeof o.osm !== 'object') return null;
  const osm: Partial<Record<OsmLayer, number>> = {};
  for (const layer of OSM_LAYERS) {
    const n = (o.osm as Record<string, unknown>)[layer];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) osm[layer] = n;
  }
  return { v: o.v, region: o.region, built_at: o.built_at, osm };
}

/**
 * Что сказать человеку о покрытии пакета. Три исхода (§4.0):
 *   null при отсутствии паспорта — «не знаю», карта молчит;
 *   null при живых тропах — говорить нечего, тишина значит «идите»;
 *   строка — чего именно нет, и что это НЕ сбой загрузки.
 *
 * Судятся только слои, по которым принимают решение в поле: тропы и дороги.
 * Пустой ледник или пустой болотный слой — обычное дело и не новость.
 */
export function coverageNotice(m: PackManifest | null): string | null {
  if (!m) return null;
  const paths = m.osm.paths;
  const roads = m.osm.roads;
  if (paths === undefined || roads === undefined) return null;
  const counted = OSM_LAYERS.map((l) => m.osm[l]).filter((n): n is number => n !== undefined);
  const allEmpty = counted.length === OSM_LAYERS.length && counted.every((n) => n === 0);
  if (allEmpty) {
    return 'В OSM для этого пакета пусто: ни троп, ни дорог, ни воды. На карте только рельеф, горизонтали и места платформы. Это не сбой загрузки — данных нет.';
  }
  if (paths === 0 && roads === 0) {
    return 'Троп и дорог в OSM для этого пакета нет — линий пути на карте не будет. Это не сбой загрузки — данных нет.';
  }
  if (paths === 0) {
    return 'Троп в OSM для этого пакета нет, только дороги. Идти «по линии» здесь не по чему — данных нет, это не сбой.';
  }
  return null;
}
