/**
 * lib/map/pack-source.ts — где лежат пакеты своей карты.
 *
 * Пакеты НЕ живут в репозитории и не попадают в образ. Причина жёсткая:
 * §6.1 — лимит standalone 50 МБ, превышение роняет деплой. Один регион —
 * ~10 МБ рельефа плюс ~1.3 МБ горизонталей (замер 31.08 на «Авачинской
 * группе»); десять регионов реестра положили бы сборку молча и не сразу.
 *
 * Дом пакетов — то же объектное хранилище Timeweb, куда платформа уже
 * кладёт фото и видео (lib/storage/s3.ts). Собирает пакет раннер (нужны
 * Python и сеть до Copernicus), прод его только читает.
 *
 * ── Третье состояние (§4.0) ───────────────────────────────────────────────
 *
 * Хранилище может быть не настроено, а пакет региона — не собран. Это РАЗНЫЕ
 * состояния, и оба не равны «карты нет»:
 *   - `unconfigured` — мы не знаем, где искать. Чинится переменной окружения.
 *   - `not_built`    — знаем где, но для этого региона пакета ещё нет.
 * Карта обязана сказать это словами, а не показать пустой тёмный экран:
 * пустой экран неотличим от «приложение умерло», и это уже случалось с
 * Leaflet (владелец 09.08, «по кнопке карта открывается чёрный экран»).
 */

import type { RegionId } from '@/lib/geo/regions';

/** Публичная база, откуда отдаются пакеты. Пусто = хранилище не настроено. */
const PACK_BASE_URL = process.env.NEXT_PUBLIC_MAP_PACK_BASE_URL || '';

/** Ключ объекта в бакете. Одна формула на сборку и на чтение. */
export function packKey(region: RegionId, kind: 'terrain' | 'contours'): string {
  return kind === 'terrain'
    ? `map-packs/${region}.terrain.pmtiles`
    : `map-packs/${region}.contours.geojson`;
}

export type PackSource =
  | { state: 'ready'; terrainUrl: string; contoursUrl: string }
  | { state: 'unconfigured'; reason: string }
  | { state: 'not_built'; reason: string };

/**
 * Адреса пакета региона — или названная причина, почему их нет.
 *
 * `builtRegions` приходит извне (реестр собранных пакетов), а не угадывается
 * запросом к хранилищу: карта не должна ходить в сеть, чтобы выяснить, есть
 * ли у неё офлайн-данные — именно в офлайне этот запрос и не пройдёт.
 */
export function resolvePackSource(
  region: RegionId,
  builtRegions: readonly RegionId[],
): PackSource {
  if (!PACK_BASE_URL) {
    return {
      state: 'unconfigured',
      reason: 'Хранилище карт не настроено — NEXT_PUBLIC_MAP_PACK_BASE_URL пуст.',
    };
  }
  if (!builtRegions.includes(region)) {
    return {
      state: 'not_built',
      reason: 'Пакет карты для этого района ещё не собран.',
    };
  }
  const base = PACK_BASE_URL.replace(/\/+$/, '');
  return {
    state: 'ready',
    // pmtiles:// — протокол читателя PMTiles: он берёт куски файла
    // Range-запросами, а не качает целиком ради одного тайла.
    terrainUrl: `pmtiles://${base}/${packKey(region, 'terrain')}`,
    contoursUrl: `${base}/${packKey(region, 'contours')}`,
  };
}

/**
 * Собранные пакеты. Список ведётся руками и намеренно: он — обещание, что
 * файл действительно лежит в хранилище. Автоопределение опросом бакета
 * вернуло бы «не знаю» в офлайне и превратило бы честное «не собран» в
 * «карты нет».
 */
export const BUILT_PACK_REGIONS: readonly RegionId[] = [
  // 31.08, прогон №2 сборки: terrain-RGB (278 тайлов, z10-12, 11 МБ) и
  // горизонтали (860 линий, 128 подписываемых) лежат в бакете под
  // map-packs/. Заливка подтверждена шагом workflow, а не предположением —
  // первый прогон был зелёным с ПРОПУЩЕННОЙ заливкой, и это стоило круга.
  'avacha-group',
];
