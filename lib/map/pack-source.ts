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

import type { PackRegionId, RegionId } from '@/lib/geo/regions';
import { isGridCellId, type GridCellId } from '@/lib/geo/grid-cells';

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
export function packKey(region: PackRegionId, kind: 'terrain' | 'contours'): string {
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
export const OSM_LAYERS = [
  'water', 'waterways', 'wood', 'glacier', 'paths', 'roads', 'peaks',
  // 02.09, после осмотра карты владельцем: имён на карте не было ни одного.
  // Посёлок — ориентир обзорного вида, приют и перевал — решения поля.
  'places', 'shelters', 'passes',
  // 02.09, «от этого зависят жизни людей»: стланик и болото — непроходимость,
  // обрыв, брод и источник (горячий — ожог) — факты, по которым ступают.
  'scrub', 'wetland', 'sand', 'rock', 'residential', 'cliffs', 'fords', 'springs',
] as const;
export type OsmLayer = typeof OSM_LAYERS[number];

/** Ключ OSM-слоя района в бакете. Одна формула на заливку и на чтение. */
export function osmKey(region: PackRegionId, layer: OsmLayer): string {
  return `map-packs/${region}.osm.${layer}.geojson`;
}

/**
 * Векторный пакет района (02.09, «качественно прорисованная карта»):
 * горизонтали 20/100/500 м и все OSM-слои в одном PMTiles, нарезанном по
 * зумам (scripts/map-tiles/build_vector.sh). Читается кусками, как рельеф, —
 * в отличие от GeoJSON, который MapLibre качает целиком.
 */
export function vectorKey(region: PackRegionId): string {
  return `map-packs/${region}.vector.pmtiles`;
}

/**
 * Имена слоёв внутри векторного пакета — контракт между build_vector.sh и
 * стилем (source-layer). Горизонтали двумя слоями: частые (20 м) отдельно,
 * они появляются только с z13.
 */
export const VECTOR_LAYERS = ['contours', 'contours_fine', ...OSM_LAYERS] as const;
export type VectorLayer = typeof VECTOR_LAYERS[number];

/**
 * Обещание, что векторный пакет района лежит в хранилище — того же рода, что
 * BUILT_PACK_REGIONS. Пока района здесь нет, карта читает GeoJSON-слои, как
 * раньше: два пути в стиле живут ради перехода, не навсегда.
 */
export const VECTOR_BUILT_REGIONS: readonly RegionId[] = [
  // 02.09, прогон 60 (run 33693609744): 8.78 МБ — против 13.5 МБ прежних
  // GeoJSON, и это уже с 20-метровыми горизонталями. tippecanoe — 7 с.
  'avacha-group',
  // 02.09, прогоны 61-69: остальные девять районов той же сборкой.
  'paratunka',
  'nalychevo',
  'central-volcanoes',
  'mutnovsky-gorely',
  'south-kamchatka',
  'kronotsky',
  'klyuchevskoy',
  'esso-bystrinsky',
  'commander-islands',
];

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
  // 02.09, прогон 12 (run 33636062414): семь слоёв Центральных вулканов,
  // 4.7 МБ; дорог там нет — слой roads пустой, и это правда о месте.
  'central-volcanoes',
  // 02.09, прогон 14 (run 33641572963): семь слоёв Ключевской, 7.5 МБ.
  'klyuchevskoy',
  // 02.09, прогон 15 (run 33643864892): семь слоёв Южной Камчатки, 3.2 МБ.
  'south-kamchatka',
  // 02.09, прогон 17 (run 33657453826): семь слоёв Эссо, 5 МБ.
  'esso-bystrinsky',
  // 02.09, прогон 18 (run 33658878008): семь слоёв Кроноцкого, 3.8 МБ;
  // дорог в заповеднике нет — слой roads пустой.
  'kronotsky',
  // 02.09, прогон 19 (run 33665191894): семь слоёв Командор, 0.74 МБ;
  // леса и ледников на островах нет — слои wood и glacier пустые.
  'commander-islands',
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
      /** Векторный пакет `pmtiles://…`; null — не собран (см. VECTOR_BUILT_REGIONS). */
      vectorUrl: string | null;
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
  region: PackRegionId,
  builtRegions: readonly PackRegionId[],
  baseUrl: string | null,
): PackSource {
  if (!baseUrl) {
    return {
      state: 'unconfigured',
      reason: `Хранилище карт не настроено — ${MAP_PACK_BASE_URL_ENV} пуст.`,
    };
  }
  const PACK_BASE_URL = baseUrl;
  const base = PACK_BASE_URL.replace(/\/+$/, '');
  // Клетка сетки собирается всем конвейером сразу (рельеф, горизонтали,
  // OSM, вектор), и обещание у неё одно — BUILT_GRID_CELLS.
  if (isGridCellId(region)) {
    if (!BUILT_GRID_CELLS.includes(region)) {
      return { state: 'not_built', reason: 'Пакет карты для этой клетки ещё не собран.' };
    }
    return {
      state: 'ready',
      terrainUrl: `pmtiles://${base}/${packKey(region, 'terrain')}`,
      contoursUrl: `${base}/${packKey(region, 'contours')}`,
      terrainMaxZoom: PACK_TERRAIN_MAXZOOM,
      glyphsUrl: PACK_GLYPHS.ready ? `${base}/${glyphKey('{fontstack}', '{range}')}` : null,
      glyphsFont: PACK_GLYPHS.fontstack,
      osmUrls: Object.fromEntries(OSM_LAYERS.map((l) => [l, `${base}/${osmKey(region, l)}`])) as Partial<Record<OsmLayer, string>>,
      vectorUrl: `pmtiles://${base}/${vectorKey(region)}`,
    };
  }
  if (!builtRegions.includes(region)) {
    return {
      state: 'not_built',
      reason: 'Пакет карты для этого района ещё не собран.',
    };
  }
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
    vectorUrl: VECTOR_BUILT_REGIONS.includes(region) ? `pmtiles://${base}/${vectorKey(region)}` : null,
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
  // и поднят до 200. 03.09, прогон 90 (run 33740498279): bbox расширен на
  // запад до 157.6 (Верхне-Опальские источники после правки координаты),
  // вектор 14.31 МБ — реестр здесь не трогается, это тот же район.
  'mutnovsky-gorely',
  // 02.09, прогон 7 (run 33625693124): рельеф 61.0 МБ, горизонтали 5.69 МБ,
  // с OSM 72.7 МБ.
  'nalychevo',
  // 02.09, прогон 12 (run 33636062414): первый крупный район (2.0 кв.°) —
  // рельеф 111.45 МБ (2505 тайлов), горизонтали 11.37 МБ, с OSM 127.5 МБ.
  // Overpass на такой площади — 40 клеток по 0.25° с паузами, ~45 минут;
  // клетки кэшируются между прогонами.
  'central-volcanoes',
  // 02.09, прогон 14 (run 33641572963): 2.2 кв.° — рельеф 144.44 МБ,
  // горизонтали 11.15 МБ, с OSM 163 МБ. Самый большой пакет на сегодня;
  // потолок 200 МБ.
  'klyuchevskoy',
  // 02.09, прогон 15 (run 33643864892): 2.4 кв.°, но много моря — рельеф
  // 92.81 МБ, горизонтали 8.17 МБ, с OSM 104 МБ. Overpass занял 58 минут.
  'south-kamchatka',
  // 02.09, прогон 17 (run 33657453826): 2.8 кв.° суши — рельеф 190 МБ,
  // горизонтали 16 МБ, с OSM 209 МБ. Самый большой пакет реестра; ради
  // него потолок сборки поднят до 256 МБ.
  'esso-bystrinsky',
  // 02.09, прогон 18 (run 33658878008): 2.5 кв.°, восточное побережье —
  // рельеф 82.18 МБ, горизонтали 8.59 МБ, с OSM 94.5 МБ.
  'kronotsky',
  // 02.09, прогон 19 (run 33665191894): острова в океане, суши мало —
  // рельеф 11.42 МБ, горизонтали 0.90 МБ, с OSM 13.1 МБ. Последний из
  // десяти районов реестра.
  'commander-islands',
];

/**
 * Собранные клетки сетки «вся Камчатка» (lib/geo/grid-cells.ts). То же
 * обещание, что BUILT_PACK_REGIONS, но одно на все ярусы: клетка собирается
 * целиком (рельеф, горизонтали, OSM, вектор) одним прогоном. Ставится после
 * заливки, не до. Порядок — порядок сборки: по номеру прогона видно, что
 * когда залито.
 */
export const BUILT_GRID_CELLS: readonly GridCellId[] = [
  // 03.09, прогон 91 (run 33742877180): проба клетки — Верхне-Опальские,
  // Асача, Опала. Рельеф 2 мин, Overpass 25 мин, вектор 11.54 МБ.
  'cell-52n157e',
  // 03.09, волна 1 (прогоны 92-101) — юг полуострова десятью клетками
  // одним залпом, порядок здесь — порядок запуска. Долгий шаг везде один и
  // тот же: Overpass, 15-40 мин на клетку; рельеф и вектор — минуты.
  'cell-51n156e',
  'cell-51n157e',
  'cell-51n158e',
  'cell-52n156e',
  'cell-52n158e',
  // Прогон 97 упал на горизонталях, пересобран прогоном 102 (run
  // 33774697725) после починки build_contours.py. Юго-западный берег,
  // max высоты 57 м — весь рельеф НИЖЕ первой ступени (100 м), поэтому у
  // клетки пустой файл горизонталей (0.00 МБ). Это факт о низком береге, а
  // не недоделка: линий там нет. Рельеф 0.67 МБ, вектор 0.08 МБ, OSM —
  // вода 2, реки 15, тропы 20, песок 3, остальные слои пусты.
  'cell-53n155e',
  'cell-53n156e',
  'cell-53n157e',
  'cell-53n158e',
  'cell-53n159e',
];
