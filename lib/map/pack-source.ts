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

/**
 * Публичная база, откуда отдаются пакеты, приходит СВЕРХУ — параметром.
 *
 * Раньше здесь стояло `process.env.NEXT_PUBLIC_MAP_PACK_BASE_URL` на уровне
 * модуля, и это не работало на проде НИ РАЗУ, хотя переменная была задана
 * правильно. Разбор 01.09:
 *
 *   - `NEXT_PUBLIC_*` подставляется в клиентский бандл на этапе `next build`;
 *   - `next build` у нас идёт ВНУТРИ образа Docker;
 *   - Timeweb отдаёт переменные приложения контейнеру при ЗАПУСКЕ, а в сборку
 *     их не передаёт — в Dockerfile нет ни одного `ARG`/`ENV` для них.
 *
 * Отсюда состояние, которое стоило полудня: сервер переменную видит (читает
 * в момент запроса, диагностика показывала `base_url_matches: true`), а
 * клиент получает пустую строку. Ни пересборка, ни инкогнито, ни сброс
 * service worker не помогали — и не могли.
 *
 * Поэтому адрес читается на СЕРВЕРЕ в момент запроса и передаётся вниз
 * пропом. Это ещё и честнее по офлайну: значение приезжает в HTML вместе со
 * страницей, а не отдельным запросом, которого в поле может не быть.
 */
export const MAP_PACK_BASE_URL_ENV = 'NEXT_PUBLIC_MAP_PACK_BASE_URL';

/** Ключ объекта в бакете. Одна формула на сборку и на чтение. */
export function packKey(region: RegionId, kind: 'terrain' | 'contours'): string {
  return kind === 'terrain'
    ? `map-packs/${region}.terrain.pmtiles`
    : `map-packs/${region}.contours.geojson`;
}

/**
 * Максимальный зум пакета рельефа — тот же, что печёт конвейер
 * (scripts/map-tiles/build_terrain.py, MAXZOOM). Одно число на сборку и на
 * чтение: сторож tests/unit/map-pack-readiness.test.ts сверяет их. Клиент
 * с меньшим числом не просил бы уровень, который в архиве есть; с большим —
 * просил бы тайлы, которых нет.
 */
export const PACK_TERRAIN_MAXZOOM = 13;

/**
 * Глифы для подписей — свои, в том же хранилище (02.09). Скачивает и заливает
 * раннер (map-pack-build.yml, шаг «Глифы»), диапазоны 0-255 (цифры, знак
 * градуса) и 1024-1279 (кириллица). Не с чужого CDN: иначе «карта
 * сохранена» лгало бы — тайлы в пакете, а числа на них приезжают из сети.
 *
 * `ready` — обещание, что файлы в хранилище, того же рода, что
 * BUILT_PACK_REGIONS: без него стиль не создаёт слой подписей вовсе.
 */
export const PACK_GLYPHS = {
  fontstack: 'Noto Sans Regular',
  ranges: ['0-255', '1024-1279'],
  ready: true,
} as const;

/** Ключ файла глифов в бакете. Одна формула на заливку и на чтение. */
export function glyphKey(fontstack: string, range: string): string {
  return `map-packs/glyphs/${fontstack}/${range}.pbf`;
}

/**
 * OSM-слои пакета (02.09, третий шаг итерации): вода, реки, лес, ледники,
 * тропы, дороги, вершины. Список — тот же, что печёт
 * scripts/map-tiles/build_osm.py (LAYERS); сторож сверяет.
 */
export const OSM_LAYERS = ['water', 'waterways', 'wood', 'glacier', 'paths', 'roads', 'peaks'] as const;
export type OsmLayer = typeof OSM_LAYERS[number];

/** Ключ OSM-слоя района в бакете. Одна формула на заливку и на чтение. */
export function osmKey(region: RegionId, layer: OsmLayer): string {
  return `map-packs/${region}.osm.${layer}.geojson`;
}

/**
 * Обещание, что OSM-слои лежат в хранилище для района, — того же рода, что
 * BUILT_PACK_REGIONS. Ставится после заливки, не до: карта с адресами слоёв,
 * которых нет, сыпала бы ошибками загрузки поверх живого рельефа.
 */
export const OSM_BUILT_REGIONS: readonly RegionId[] = [
  // 02.09, прогон 2 пакета (run 33583128951): семь слоёв залиты вместе с
  // рельефом GLO-30 и глифами.
  'avacha-group',
  // 02.09, прогон 5 (run 33624756412): семь слоёв Паратунки залиты, 4.3 МБ.
  'paratunka',
  // 02.09, прогон 6 (run 33625171834): семь слоёв Мутновского, 5.7 МБ.
  'mutnovsky-gorely',
  // 02.09, прогон 7 (run 33625693124): семь слоёв Налычева, 6.0 МБ.
  'nalychevo',
];

export type PackSource =
  | {
      state: 'ready';
      terrainUrl: string;
      contoursUrl: string;
      terrainMaxZoom: number;
      /** Шаблон MapLibre `{fontstack}/{range}.pbf`; null — подписей нет. */
      glyphsUrl: string | null;
      glyphsFont: string;
      /** Адреса OSM-слоёв; пусто — слоёв для района ещё нет (см. OSM_BUILT_REGIONS). */
      osmUrls: Partial<Record<OsmLayer, string>>;
    }
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
  baseUrl: string | null,
): PackSource {
  if (!baseUrl) {
    return {
      state: 'unconfigured',
      reason: `Хранилище карт не настроено — ${MAP_PACK_BASE_URL_ENV} пуст.`,
    };
  }
  const PACK_BASE_URL = baseUrl;
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
    terrainMaxZoom: PACK_TERRAIN_MAXZOOM,
    glyphsUrl: PACK_GLYPHS.ready ? `${base}/${glyphKey('{fontstack}', '{range}')}` : null,
    glyphsFont: PACK_GLYPHS.fontstack,
    osmUrls: OSM_BUILT_REGIONS.includes(region)
      ? Object.fromEntries(OSM_LAYERS.map((l) => [l, `${base}/${osmKey(region, l)}`])) as Partial<Record<OsmLayer, string>>
      : {},
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
  // 02.09, прогон 5 (run 33624756412), после слов владельца «карта
  // понравилась, прорисовать остальные районы»: рельеф GLO-30 36.47 МБ,
  // горизонтали 3.72 МБ — заливка подтверждена шагом workflow.
  'paratunka',
  // 02.09, прогон 6 (run 33625171834): рельеф 53.27 МБ, горизонтали 5.49 МБ,
  // с OSM 64.5 МБ — первый пакет над прежним потолком 60, ради него потолок
  // и поднят до 200.
  'mutnovsky-gorely',
  // 02.09, прогон 7 (run 33625693124): рельеф 61.0 МБ, горизонтали 5.69 МБ,
  // с OSM 72.7 МБ.
  'nalychevo',
];
