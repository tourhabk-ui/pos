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

import { isOverviewId, type PackRegionId, type RegionId } from '@/lib/geo/regions';
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
 * Верхний зум ОБЗОРНОГО пакета — на единицу ниже нижнего зума пакетов
 * района и клетки (build_terrain.py MINZOOM = 8). Ярусы не пересекаются
 * намеренно: на любом зуме рельеф рисует ровно один из них. Совпадут —
 * и на z8 лягут два рельефа сразу, прореженный поверх подробного.
 * Число печёт scripts/map-tiles/build_overview.py (MAXZOOM); сторож сверяет.
 */
export const OVERVIEW_MAX_ZOOM = 7;

/**
 * Обещание, что обзорный пакет края лежит в хранилище. Ставится после
 * заливки, не до, — как и все прочие реестры этого файла.
 *
 * 04.09, прогон 1 обзора (run 33800870746): 4.77 МБ на весь край, 404 с,
 * зумы 4-7, залит.
 *
 * Полнота проверена КОСВЕННО, и это стоит знать: доля заполнения мозаики
 * осталась в той части лога, которая наружу не отдаётся, поэтому вместо
 * чтения числа пришлось считать вес. На bbox края зумы 4-7 дают 123 тайла,
 * то есть 39.7 КБ на тайл. Пустой terrain-RGB (все высоты нулевые) жмётся
 * в сотни байт — такой средний вес возможен только у заполненной мозаики.
 * Довод крепкий, но это довод, а не замер; чтобы следующий прогон отвечал
 * прямо, итог сборки уходит в сводку прогона (map-overview-build.yml).
 */
export const OVERVIEW_BUILT = true;

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
 * Места платформы (05.09) — свой слой, не OSM.
 *
 * Проверка хранилища после 112 клеток: у корякских клеток слои OSM «тропы»,
 * «приюты», «посёлки» по 0.00 МБ — в OSM там пусто. Наши `places` (779 мест,
 * у 763 профиль безопасности) есть и там, а на офлайн-карте их не было вовсе.
 *
 * Отдельный ключ и отдельный реестр — не прихоть: OSM_LAYERS трижды прибит
 * к build_osm.py и к атрибуции OpenStreetMap (map-pack-osm.test.ts), а это
 * НАШИ данные с нашей атрибуцией. Печёт map-places-build.yml одним прогоном
 * на все пакеты (scripts/map-tiles/build-places.ts), не пересборкой пакетов.
 */
export function placesKey(region: PackRegionId): string {
  return `map-packs/${region}.places.geojson`;
}

/** Атрибуция слоя — одна строка на эндпоинт (places-export) и на стиль. */
export const PLACES_ATTRIBUTION = '© Ведар — места и профили безопасности платформы';

/**
 * Обещание, что `<region>.places.geojson` лежит в хранилище — того же рода,
 * что VECTOR_BUILT_REGIONS: ставится ПОСЛЕ заливки прогоном, не до. Пока
 * список пуст, карта слой не просит и ни один пакет не ждёт файла, которого
 * нет. Проверка хранилища (verify-packs) читает этот же список.
 */
export const PLACES_BUILT: readonly PackRegionId[] = [
  // Прогон map-places-build run 2 (33945055783, main, 05.09): 123 пакета
  // залиты, отказов 0. Порядок — тот же, что у placesTargets(): обзор,
  // 10 районов, 112 клеток. Новая клетка сюда попадает ПОСЛЕ своего прогона.
  'krai-overview',
  'avacha-group', 'paratunka', 'mutnovsky-gorely', 'nalychevo', 'central-volcanoes',
  'klyuchevskoy', 'south-kamchatka', 'esso-bystrinsky', 'kronotsky', 'commander-islands',
  'cell-52n157e', 'cell-51n156e', 'cell-51n157e', 'cell-51n158e', 'cell-52n156e',
  'cell-52n158e', 'cell-53n155e', 'cell-53n156e', 'cell-53n157e', 'cell-53n158e',
  'cell-53n159e', 'cell-54n156e', 'cell-54n157e', 'cell-54n158e', 'cell-54n159e',
  'cell-54n160e', 'cell-54n161e', 'cell-54n162e', 'cell-54n166e', 'cell-54n167e',
  'cell-54n155e', 'cell-55n155e', 'cell-55n156e', 'cell-55n157e', 'cell-55n158e',
  'cell-55n159e', 'cell-55n160e', 'cell-55n161e', 'cell-55n166e', 'cell-56n155e',
  'cell-56n156e', 'cell-56n157e', 'cell-56n158e', 'cell-56n159e', 'cell-56n160e',
  'cell-56n161e', 'cell-56n162e', 'cell-56n163e', 'cell-57n156e', 'cell-57n157e',
  'cell-57n158e', 'cell-57n159e', 'cell-57n160e', 'cell-57n161e', 'cell-57n162e',
  'cell-57n163e', 'cell-58n158e', 'cell-58n160e', 'cell-58n161e', 'cell-58n162e',
  'cell-58n159e', 'cell-58n163e', 'cell-58n164e', 'cell-59n159e', 'cell-59n160e',
  'cell-59n161e', 'cell-59n162e', 'cell-59n163e', 'cell-59n164e', 'cell-59n166e',
  'cell-60n161e', 'cell-60n162e', 'cell-60n163e', 'cell-60n164e', 'cell-60n165e',
  'cell-60n166e', 'cell-60n167e', 'cell-60n168e', 'cell-60n169e', 'cell-60n170e',
  'cell-60n171e', 'cell-61n162e', 'cell-61n163e', 'cell-61n164e', 'cell-61n165e',
  'cell-61n166e', 'cell-61n167e', 'cell-61n168e', 'cell-61n169e', 'cell-61n170e',
  'cell-61n171e', 'cell-61n172e', 'cell-61n173e', 'cell-61n174e', 'cell-62n162e',
  'cell-62n163e', 'cell-62n164e', 'cell-62n165e', 'cell-62n166e', 'cell-62n167e',
  'cell-62n168e', 'cell-62n169e', 'cell-62n170e', 'cell-62n171e', 'cell-62n172e',
  'cell-62n173e', 'cell-62n174e', 'cell-63n162e', 'cell-63n163e', 'cell-63n164e',
  'cell-63n165e', 'cell-63n166e', 'cell-63n167e', 'cell-63n168e', 'cell-63n169e',
  'cell-64n162e', 'cell-64n163e', 'cell-64n164e', 'cell-64n165e', 'cell-64n166e',
  'cell-64n167e', 'cell-64n168e',
];

/** Адрес слоя мест — одно правило на все три ветки resolvePackSource. */
function placesUrlFor(region: PackRegionId, base: string): string | null {
  return PLACES_BUILT.includes(region) ? `${base}/${placesKey(region)}` : null;
}

/**
 * Паспорт пакета (05.09, lib/map/pack-manifest.ts): число объектов по слоям
 * OSM, снятое с залитых файлов. По нему карта говорит словами «троп в OSM
 * здесь нет», а не молчит, как при сбое загрузки. Ключ — рядом с пакетом.
 */
export function manifestKey(region: PackRegionId): string {
  return `map-packs/${region}.manifest.json`;
}

/**
 * Обещание, что паспорт лежит в хранилище — того же рода, что PLACES_BUILT:
 * ставится ПОСЛЕ прогона build-manifests / заливки пакета. Нет паспорта —
 * карта не просит его и не судит о покрытии: «не знаю», не «пусто».
 */
export const MANIFEST_BUILT: readonly PackRegionId[] = [
  // Прогон map-pack-manifest run 1 (33952537390, 05.09): 122 паспорта записаны,
  // отказов 0. Порядок — manifestTargets(): районы с OSM, затем все клетки.
  'avacha-group', 'paratunka', 'mutnovsky-gorely', 'nalychevo', 'central-volcanoes',
  'klyuchevskoy', 'south-kamchatka', 'esso-bystrinsky', 'kronotsky', 'commander-islands',
  'cell-52n157e', 'cell-51n156e', 'cell-51n157e', 'cell-51n158e', 'cell-52n156e',
  'cell-52n158e', 'cell-53n155e', 'cell-53n156e', 'cell-53n157e', 'cell-53n158e',
  'cell-53n159e', 'cell-54n156e', 'cell-54n157e', 'cell-54n158e', 'cell-54n159e',
  'cell-54n160e', 'cell-54n161e', 'cell-54n162e', 'cell-54n166e', 'cell-54n167e',
  'cell-54n155e', 'cell-55n155e', 'cell-55n156e', 'cell-55n157e', 'cell-55n158e',
  'cell-55n159e', 'cell-55n160e', 'cell-55n161e', 'cell-55n166e', 'cell-56n155e',
  'cell-56n156e', 'cell-56n157e', 'cell-56n158e', 'cell-56n159e', 'cell-56n160e',
  'cell-56n161e', 'cell-56n162e', 'cell-56n163e', 'cell-57n156e', 'cell-57n157e',
  'cell-57n158e', 'cell-57n159e', 'cell-57n160e', 'cell-57n161e', 'cell-57n162e',
  'cell-57n163e', 'cell-58n158e', 'cell-58n160e', 'cell-58n161e', 'cell-58n162e',
  'cell-58n159e', 'cell-58n163e', 'cell-58n164e', 'cell-59n159e', 'cell-59n160e',
  'cell-59n161e', 'cell-59n162e', 'cell-59n163e', 'cell-59n164e', 'cell-59n166e',
  'cell-60n161e', 'cell-60n162e', 'cell-60n163e', 'cell-60n164e', 'cell-60n165e',
  'cell-60n166e', 'cell-60n167e', 'cell-60n168e', 'cell-60n169e', 'cell-60n170e',
  'cell-60n171e', 'cell-61n162e', 'cell-61n163e', 'cell-61n164e', 'cell-61n165e',
  'cell-61n166e', 'cell-61n167e', 'cell-61n168e', 'cell-61n169e', 'cell-61n170e',
  'cell-61n171e', 'cell-61n172e', 'cell-61n173e', 'cell-61n174e', 'cell-62n162e',
  'cell-62n163e', 'cell-62n164e', 'cell-62n165e', 'cell-62n166e', 'cell-62n167e',
  'cell-62n168e', 'cell-62n169e', 'cell-62n170e', 'cell-62n171e', 'cell-62n172e',
  'cell-62n173e', 'cell-62n174e', 'cell-63n162e', 'cell-63n163e', 'cell-63n164e',
  'cell-63n165e', 'cell-63n166e', 'cell-63n167e', 'cell-63n168e', 'cell-63n169e',
  'cell-64n162e', 'cell-64n163e', 'cell-64n164e', 'cell-64n165e', 'cell-64n166e',
  'cell-64n167e', 'cell-64n168e',
];

function manifestUrlFor(region: PackRegionId, base: string): string | null {
  return MANIFEST_BUILT.includes(region) ? `${base}/${manifestKey(region)}` : null;
}

/**
 * Океан обзорного яруса (05.09, build_ocean.py): bbox обзора минус полигоны
 * суши OSM. Ложится поверх гипсометрии, чтобы дыры покрытия DEM посреди
 * моря не читались сушей. Только у обзора: клетки читают DEM на полной
 * сетке, и ноль высоты там — честное море.
 */
export function oceanKey(region: PackRegionId): string {
  return `map-packs/${region}.ocean.geojson`;
}

/** Обещание, что океан обзора залит (map-overview-ocean.yml). Ставится ПОСЛЕ прогона. */
// Прогон map-overview-ocean run 1 (33952766081, 05.09): 180 КБ залито.
export const OVERVIEW_OCEAN_BUILT = true;

function oceanUrlFor(region: PackRegionId, base: string): string | null {
  return isOverviewId(region) && OVERVIEW_OCEAN_BUILT ? `${base}/${oceanKey(region)}` : null;
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
      /** Места платформы, GeoJSON; null — слой не залит (см. PLACES_BUILT). */
      placesUrl: string | null;
      /** Паспорт пакета (число объектов по слоям OSM); null — не залит (см. MANIFEST_BUILT). */
      manifestUrl: string | null;
      /** Океан поверх гипсометрии, GeoJSON; только у обзора и только когда залит (OVERVIEW_OCEAN_BUILT). */
      oceanUrl: string | null;
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
  // Обзорный ярус — только рельеф, зумы 4-7. Горизонталей и OSM у него нет
  // по замыслу: на таком масштабе стометровая линия — шум в полпикселя, а
  // тропа не читается вовсе. Файл горизонталей рядом лежит ПУСТОЙ (сборщик
  // пишет коллекцию без объектов), и это тот же ответ словами: линий этого
  // яруса нет. Пустой список osmUrls оставляет оверлею только рельеф и тень.
  if (isOverviewId(region)) {
    if (!OVERVIEW_BUILT) {
      return { state: 'not_built', reason: 'Обзорный пакет края ещё не собран.' };
    }
    return {
      state: 'ready',
      terrainUrl: `pmtiles://${base}/${packKey(region, 'terrain')}`,
      contoursUrl: `${base}/${packKey(region, 'contours')}`,
      terrainMaxZoom: OVERVIEW_MAX_ZOOM,
      glyphsUrl: PACK_GLYPHS.ready ? `${base}/${glyphKey('{fontstack}', '{range}')}` : null,
      glyphsFont: PACK_GLYPHS.fontstack,
      osmUrls: {},
      vectorUrl: null,
      // Посёлки-ориентиры нужнее всего именно на обзоре (z4-7).
      placesUrl: placesUrlFor(region, base),
    manifestUrl: manifestUrlFor(region, base),
    oceanUrl: oceanUrlFor(region, base),
    };
  }
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
      placesUrl: placesUrlFor(region, base),
    manifestUrl: manifestUrlFor(region, base),
    oceanUrl: oceanUrlFor(region, base),
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
    placesUrl: placesUrlFor(region, base),
    manifestUrl: manifestUrlFor(region, base),
    oceanUrl: oceanUrlFor(region, base),
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
  // 03.09, волна 2 (прогоны 103-112) — широта 54°, от западного берега до
  // Командорского направления.
  'cell-54n156e',
  'cell-54n157e',
  'cell-54n158e',
  'cell-54n159e',
  'cell-54n160e',
  'cell-54n161e',
  'cell-54n162e',
  'cell-54n166e',
  'cell-54n167e',
  // 04.09, прогон 123: cell-54n155e (прогон 103) отменился по
  // timeout-minutes=120 — OSM-шаг провисел 2 часа, первый такой случай за
  // 122 прогона (вероятная причина — Overpass под нагрузкой десяти
  // параллельных клеток волны 3). Пересобрана одна, без соседей — 5.5 мин.
  'cell-54n155e',
  // 04.09, волна 3 (прогоны 113-122) — широта 55-56°, центр полуострова.
  'cell-55n155e',
  'cell-55n156e',
  'cell-55n157e',
  'cell-55n158e',
  'cell-55n159e',
  'cell-55n160e',
  'cell-55n161e',
  'cell-55n166e',
  'cell-56n155e',
  'cell-56n156e',
  // 04.09, волна 4 (прогоны 124-133) — широта 56-57°, восток-центр полуострова.
  'cell-56n157e',
  'cell-56n158e',
  'cell-56n159e',
  'cell-56n160e',
  'cell-56n161e',
  'cell-56n162e',
  'cell-56n163e',
  'cell-57n156e',
  'cell-57n157e',
  'cell-57n158e',
  // 04.09, волна 5 (прогоны 134-143) — широта 57-58°, ближе к северу
  // полуострова. cell-58n159e (прогон 140) ещё строилась на момент правки —
  // войдёт отдельной строкой по факту заливки.
  'cell-57n159e',
  'cell-57n160e',
  'cell-57n161e',
  'cell-57n162e',
  'cell-57n163e',
  'cell-58n158e',
  'cell-58n160e',
  'cell-58n161e',
  'cell-58n162e',
  // cell-58n159e (прогон 140) провисела на OSM-шаге дольше 30 минут, но
  // достроилась зелёной без вмешательства (Overpass под нагрузкой волны 5).
  'cell-58n159e',
  // 04.09, волна 6 (прогоны 144-152) — широта 58-59°, последняя на
  // полуострове. С этой волной полуостров (lat < 60°, 60 клеток) закрыт
  // целиком — дальше только Корякия (lat >= 60°, 52 клетки).
  'cell-58n163e',
  'cell-58n164e',
  'cell-59n159e',
  'cell-59n160e',
  'cell-59n161e',
  'cell-59n162e',
  'cell-59n163e',
  'cell-59n164e',
  'cell-59n166e',
  // 04.09, Корякия волна 1 (прогоны 153-162) — широта 60°, первая волна
  // севернее полуострова (lat >= 60°).
  'cell-60n161e',
  'cell-60n162e',
  'cell-60n163e',
  'cell-60n164e',
  'cell-60n165e',
  'cell-60n166e',
  'cell-60n167e',
  'cell-60n168e',
  'cell-60n169e',
  'cell-60n170e',
  // 04.09, Корякия волна 2 (прогоны 163-172) — замыкает широту 60° и
  // открывает 61°.
  'cell-60n171e',
  'cell-61n162e',
  'cell-61n163e',
  'cell-61n164e',
  'cell-61n165e',
  'cell-61n166e',
  'cell-61n167e',
  'cell-61n168e',
  'cell-61n169e',
  'cell-61n170e',
  // 04.09, Корякия волна 3 (прогоны 173-182) — замыкает широту 61° и
  // открывает 62°.
  'cell-61n171e',
  'cell-61n172e',
  'cell-61n173e',
  'cell-61n174e',
  'cell-62n162e',
  'cell-62n163e',
  'cell-62n164e',
  'cell-62n165e',
  'cell-62n166e',
  'cell-62n167e',
  // 04.09, Корякия волна 4 (прогоны 183-192) — широта 62° до конца,
  // открывает 63°. Собраны СТАРЫМ кодировщиком (пропуск DEM = высота 0) —
  // войдут в общую пересборку после починки NODATA_SENTINEL_M.
  'cell-62n168e',
  'cell-62n169e',
  'cell-62n170e',
  'cell-62n171e',
  'cell-62n172e',
  'cell-62n173e',
  'cell-62n174e',
  'cell-63n162e',
  'cell-63n163e',
  'cell-63n164e',
  // 04.09, Корякия волна 5 (прогоны 193-204) — ПОСЛЕДНЯЯ: закрывает
  // широты 63-64° и весь реестр 112/112. Собраны НОВЫМ кодировщиком
  // (NODATA_SENTINEL_M) — пересборка им не нужна.
  'cell-63n165e',
  'cell-63n166e',
  'cell-63n167e',
  'cell-63n168e',
  'cell-63n169e',
  'cell-64n162e',
  'cell-64n163e',
  'cell-64n164e',
  'cell-64n165e',
  'cell-64n166e',
  'cell-64n167e',
  'cell-64n168e',
];
