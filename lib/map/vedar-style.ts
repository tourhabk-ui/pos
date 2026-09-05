/**
 * lib/map/vedar-style.ts — стиль своей карты Ведара для MapLibre.
 *
 * ── Зачем своя карта ──────────────────────────────────────────────────────
 *
 * 28.08 владелец отключил массовую закачку тайлов: политика OSM запрещает
 * bulk download с tile.openstreetmap.org, и «Скачать регион» стало честно
 * отвечать отказом. Условие возврата записано там же, в public/sw.js:
 * «Вернётся, когда появится собственный источник (PMTiles)». Плюс 31.08
 * владелец принёс референс тёмной топоподложки и сказал, что других
 * вариантов нет. Оба требования закрываются одним: свой пакет рельефа.
 *
 * ── Почему стиль — функция, а не файл ────────────────────────────────────
 *
 * Палитра берётся из токенов §2, а не пишется числами в JSON. Причина не
 * в опрятности: hillshade считает MapLibre на клиенте ИЗ ВЫСОТ, поэтому
 * тёмная и светлая карта — это две таблицы цветов над ОДНИМ пакетом, а не
 * два пакета. Требование владельца к пробе (добавка 2): обе темы ценой
 * одного файла. Функция это гарантирует по построению — забыть обновить
 * второй JSON невозможно, второго JSON нет.
 *
 * ── Чего в пробе нет и почему ────────────────────────────────────────────
 *
 * Рек, леса и троп с референса здесь НЕТ. Не потому, что не нужны — их
 * источник (OSM) недостижим из сборочного контура: download.geofabrik.de и
 * overpass-api.de закрыты политикой прокси (403/timeout, проверено 31.08).
 * Это «не знаю, как достать», а не «решили не делать», и молчать об этом
 * нельзя: иначе следующий читатель решит, что карта такой задумана.
 * Рельеф, горизонтали, маршрут и своё положение — есть, и этого хватает,
 * чтобы вынести вердикт о виде и об офлайне.
 *
 * ── Подписи горизонталей ─────────────────────────────────────────────────
 *
 * `symbol-placement: line` с `text-field` из свойства `ele` — самая
 * капризная часть стиля (добавка 5 владельца, отдельный чекпоинт). Числа
 * приходят ИЗ ДАННЫХ: горизонталь несёт высоту атрибутом, а не нарисованной
 * цифрой. Ровно этим карта и отличается от картинки.
 */

import { PLACES_ATTRIBUTION } from '@/lib/map/pack-source';

export type VedarMapTheme = 'dark' | 'light';

/**
 * Сигнальная высота «нет данных» — то же число, что `NODATA_SENTINEL_M` в
 * scripts/map-tiles/build_terrain.py (сторож — vedar-map-style.test.ts).
 *
 * Пропуск DEM (море Copernicus не покрывает целиком, дыра покрытия) раньше
 * кодировался в terrain-RGB как высота 0.0 — БАЙТ В БАЙТ то же, что настоящая
 * низкая суша на уровне моря. Клиент читает только байты пакета: ни
 * hillshade, ни color-relief не видят происхождения нуля. Жалоба с поля
 * 04.09 («не всё прорисовалось») была не про недостающие пакеты — про то,
 * что дыра в данных и подтверждённая суша красились ОДНИМ цветом.
 *
 * Ступени `relief` ниже красят именно эту высоту в СВОЙ цвет — не воду и не
 * сушу: «не знаю» не заполняется правдоподобной ложью (§4.0 CLAUDE.md).
 */
export const NODATA_SENTINEL_M = -500;

/**
 * Палитра карты по токенам §2. Держится здесь, а не читается из CSS:
 * MapLibre считает цвета в WebGL и до каскада не достаёт, а разъезд двух
 * копий одного цвета — та же болезнь, что §12 лечит для линий.
 */
interface MapPalette {
  /** Фон под всем — там, где нет ни рельефа, ни воды. */
  background: string;
  /** Тень склона и подсветка гребня — hillshade считается из высот. */
  shadow: string;
  highlight: string;
  accentShadow: string;
  /** Горизонтали: частые молчат, редкие подписаны. */
  contourMinor: string;
  contourMajor: string;
  contourLabel: string;
  contourLabelHalo: string;
  /** Снятый трек (§12) и его подложка. */
  track: string;
  trackCasing: string;
  /** Набросок и импорт — пунктир, приглушённый (§12): не обещают ведения. */
  sketch: string;
  /** Построение — подход по азимуту, связка (§12, connectorLine). */
  connector: string;
  /** Свой след — где человек был. Не маршрут: другой цвет, тонкая линия. */
  trail: string;
  /** OSM (02.09): заливки и линии. Приглушённые — карта полевая, не городская. */
  water: string;
  waterway: string;
  wood: string;
  glacier: string;
  path: string;
  road: string;
  peak: string;
  peakLabel: string;
  /**
   * Имена (02.09, после осмотра карты владельцем). Посёлок — главный
   * ориентир обзорного вида; приют и перевал — решения «где ночевать» и
   * «где переваливать». Приют держит цвет подписи, а не свой: на бумажной
   * топокарте домик чёрный, и лишний цвет тут спорил бы с вершинами.
   */
  place: string;
  shelter: string;
  mountainPass: string;
  waterLabel: string;
  /**
   * Гипсометрия (02.09, слово владельца «нужна качественно прорисованная
   * карта»): высота читается ЦВЕТОМ, как на бумажной топокарте, а не только
   * тенью. Пары «метры → цвет»; между ступенями MapLibre интерполирует.
   * Первая ступень — море: Copernicus DEM держит 0 над водой, и берег
   * рисуется без единого байта новых данных. Цена честности: пойма или
   * дельта на нуле высоты тоже выйдет водой.
   *
   * Своя, отдельная ступень стоит на NODATA_SENTINEL_M (04.09) — дыра
   * покрытия красится в СВОЙ цвет, не в цвет воды из абзаца выше: до этой
   * правки дыра и подтверждённое море были одним и тем же нулём, и «не
   * знаю, что здесь» выглядело как уверенное «здесь море» (§4.0).
   */
  relief: ReadonlyArray<readonly [number, string]>;
  /**
   * Покрытия и опасности (02.09, «от этого зависят жизни людей»). Стланик и
   * болото — непроходимость, их заливки читаются как «тут тяжело», не как
   * декор. Обрыв — линия цвета тревоги, брод — вода, источник — вода,
   * горячий источник — акцент: там ожог.
   */
  scrub: string;
  wetland: string;
  sand: string;
  rock: string;
  residential: string;
  cliff: string;
  spring: string;
  hotSpring: string;
}

const PALETTES: Record<VedarMapTheme, MapPalette> = {
  // Тёмная — та, что на референсе владельца 31.08. Полевой контур уже
  // тёмный по решению владельца 2026-08-15 (§2, «тёмные экраны полевого
  // контура»), так что это не новая эстетика, а продолжение принятой.
  dark: {
    background: '#0D1117',   // --bg-primary dark
    shadow: '#05070A',
    // Первый живой рендер 02.09 (Авачинский перевал): рельеф «почти
    // чёрный» — подсветка гребня #2A3B33 от фона #0D1117 не отличалась.
    // Поднята вместе с горизонталями; это первая правка по глазу владельца,
    // а не окончательная палитра — критерий приёмки пробы ещё впереди.
    highlight: '#4A6A57',
    accentShadow: '#0A1512',
    contourMinor: '#4F6B5B',
    contourMajor: '#93B39F',
    contourLabel: '#8B949E', // --text-secondary dark
    contourLabelHalo: '#0D1117',
    track: '#3FB950',        // --success
    trackCasing: '#0D1117',
    // Набросок — приглушённый: §12 запрещает ему выглядеть как трек.
    sketch: '#5E7A66',
    connector: '#8B949E',
    trail: '#00A8CC',       // --ocean dark; тот же голубой, что у следа на Leaflet
    // OSM: вода холодная, лес чуть теплее фона, ледник светлее гребня,
    // тропа — тёплая (как на референсе владельца 31.08), дорога — серая.
    water: '#12303F',
    waterway: '#2C6F8A',
    wood: '#15271C',
    glacier: '#2F3C46',
    path: '#B0835F',
    road: '#6E6A66',
    peak: '#E8734A',        // --accent dark
    peakLabel: '#F0F6FC',   // --text-primary dark
    place: '#F0F6FC',       // --text-primary dark
    shelter: '#F0F6FC',
    mountainPass: '#93B39F',
    waterLabel: '#7FB3C8',
    // Тёмная гипсометрия: низины уходят в глубокую зелень, склоны — в
    // тёплую землю, гребни и вулканы светлеют. Море — тот же холодный тон,
    // что у озёр (water), чтобы вода на карте была одного рода.
    relief: [
      [-10000, '#12303F'],
      [NODATA_SENTINEL_M - 0.5, '#12303F'],
      // Дыра покрытия — тёплый нейтральный серый, ни вода, ни суша: «не
      // знаю» не притворяется ответом.
      [NODATA_SENTINEL_M, '#3D3A35'],
      [NODATA_SENTINEL_M + 0.5, '#3D3A35'],
      [0.5, '#12303F'],
      [1, '#16261B'],
      [200, '#1B2E21'],
      [500, '#26332A'],
      [900, '#3A3A2C'],
      [1400, '#4A4332'],
      [2000, '#5A5040'],
      [2600, '#6B6358'],
      [3300, '#7E7C78'],
      [4800, '#A6A9AD'],
    ],
    scrub: '#2C3A22',
    wetland: '#1C3538',
    sand: '#403B2A',
    rock: '#41444A',
    residential: '#332D2C',
    cliff: '#D2704A',
    spring: '#5FB3D6',
    hotSpring: '#E8734A',   // --accent dark
  },
  // Светлая — не «инверсия ради галочки». Тёмная карта под прямым солнцем
  // читается хуже: запись платформы дважды говорит, что слабый сигнал на
  // солнце пропадает (прозрачность стрелки компаса, 21.08; пунктир и
  // приглушённый цвет линии, §12). Здесь тень слабее, а горизонтали и трек
  // темнее фона — контраст растёт, а не падает.
  light: {
    background: '#F5F0EB',   // --bg-primary light
    shadow: '#6B6560',
    highlight: '#FFFFFF',
    accentShadow: '#8A7F72',
    contourMinor: '#B9AC9C',
    contourMajor: '#8A7A66',
    contourLabel: '#6B6560', // --text-secondary light
    contourLabelHalo: '#F5F0EB',
    track: '#1F7A34',
    trackCasing: '#FFFFFF',
    sketch: '#6B8A74',
    connector: '#6B6560',
    trail: '#2568B0',       // --ocean light
    water: '#BFD9E8',
    waterway: '#4F88A8',
    wood: '#D9E4CC',
    glacier: '#EEF3F7',
    path: '#8A5A3A',
    road: '#8C8781',
    peak: '#D44A0C',        // --accent light
    peakLabel: '#1A1714',   // --text-primary light
    place: '#1A1714',       // --text-primary light
    shelter: '#1A1714',
    mountainPass: '#5E7A66',
    waterLabel: '#2F6280',
    // Светлая гипсометрия — классическая бумажная: зелёные низины, охра
    // склонов, серые скалы, белый снег.
    relief: [
      [-10000, '#BFD9E8'],
      [NODATA_SENTINEL_M - 0.5, '#BFD9E8'],
      // Дыра покрытия — тёплый нейтральный бежево-серый, ни вода, ни суша.
      [NODATA_SENTINEL_M, '#DAD5C9'],
      [NODATA_SENTINEL_M + 0.5, '#DAD5C9'],
      [0.5, '#BFD9E8'],
      [1, '#E3EBD3'],
      [200, '#D9E3C2'],
      [500, '#D6D8B0'],
      [900, '#D3C9A0'],
      [1400, '#CCB88C'],
      [2000, '#C2A47E'],
      [2600, '#B9A899'],
      [3300, '#C9C6C2'],
      [4800, '#F4F4F4'],
    ],
    scrub: '#D9E0BE',
    wetland: '#C6DDD8',
    sand: '#F0E6C4',
    rock: '#D6D3CD',
    residential: '#E6DAD2',
    cliff: '#9B4A26',
    spring: '#2F6F95',
    hotSpring: '#D44A0C',   // --accent light
  },
};

export interface VedarStyleSources {
  /** PMTiles с terrain-RGB. Адрес вида `pmtiles://https://.../avacha.terrain.pmtiles`. */
  terrainUrl: string;
  /** GeoJSON горизонталей — свойства `ele` (метры) и `kind` (major/minor). */
  contoursUrl: string;
  /** Родное разрешение источника высот, в зумах. Выше — сглаживание, не детализация. */
  terrainMaxZoom: number;
  /** Строка правообладателя. Лицензия Copernicus требует её на экране. */
  attribution: string;
  /**
   * Адрес шрифтовых глифов (PBF). Пусто — подписей высот НЕ БУДЕТ.
   *
   * 01.09, полевой прогон: карта рисовала чёрный прямоугольник. Причина —
   * здесь: слой `contour-label` просит `text-field`, а `glyphs` не был задан
   * вовсе. MapLibre без глифов не может отрисовать текст и отвергает стиль
   * ЦЕЛИКОМ — не «подписи пропали», а не загрузилось ничего, включая рельеф.
   * Снаружи это неотличимо от «карта не работает».
   *
   * Глифы намеренно не берутся с чужого CDN: тогда «карта сохранена» стало бы
   * ложью — тайлы в пакете, а числа на них приезжают из интернета. Пока свои
   * глифы не выложены в хранилище, слой подписей просто не создаётся: карта
   * без чисел честнее карты, которой нет.
   */
  glyphsUrl?: string | null;
  /**
   * Имя шрифта (fontstack) в хранилище глифов. Без него MapLibre просил бы
   * свой умолчальный «Open Sans Regular», которого в нашем хранилище нет,
   * и подписи молча не появились бы.
   */
  glyphsFont?: string;
  /**
   * OSM-слои района (02.09): GeoJSON по слоям. Отсутствие — законно (район
   * без OSM-выписки): слои просто не создаются, рельеф и маршрут остаются.
   */
  osmUrls?: Partial<Record<OsmLayer, string>>;
  /**
   * Векторный пакет района (02.09): горизонтали 20/100/500 м и все
   * OSM-слои одним PMTiles, нарезанным по зумам. Когда он есть, стиль
   * читает ВСЕ линии и площади из него (source-layer), а GeoJSON-адреса
   * выше не трогает: тайл берётся кусками по видимой области, GeoJSON —
   * целиком. Нет — прежний путь по GeoJSON. Два пути живут ради перехода.
   */
  vectorUrl?: string | null;
  /**
   * Места платформы (05.09): `places` + профиль безопасности одним GeoJSON
   * на пакет (`<region>.places.geojson`, реестр PLACES_BUILT). Свой слой, не
   * OSM: у корякских клеток OSM-слои пусты, а наши места есть и там. null —
   * файла нет, слоя нет; рисовать «по умолчанию» было бы обещанием.
   */
  placesUrl?: string | null;
  /**
   * Океан обзорного яруса (05.09): bbox минус полигоны суши OSM, поверх
   * гипсометрии. Дыра покрытия DEM посреди моря иначе красится «не знаю»-
   * серым и читается сушей. null — слоя нет; клеткам он не нужен.
   */
  oceanUrl?: string | null;
}

export type OsmLayer =
  | 'water' | 'waterways' | 'wood' | 'glacier' | 'paths' | 'roads' | 'peaks'
  | 'places' | 'shelters' | 'passes'
  | 'scrub' | 'wetland' | 'sand' | 'rock' | 'residential' | 'cliffs' | 'fords' | 'springs';
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Куда слой смотрит: geojson-источник по слою или source-layer векторного пакета. */
type SourceRef = { source: string; 'source-layer'?: string };

/**
 * Разрешение «слой → источник» для обоих путей. Сборщики слоёв не знают,
 * откуда данные: они спрашивают `r.osm('wood')` и получают либо ссылку, либо
 * null («слоя у района нет — не создавать»). Правила вида остаются одни на
 * оба пути — ровно ради этого resolver, а не два набора сборщиков.
 */
interface LayerRefs {
  vector: boolean;
  /** Источники стиля этого пути (без terrain и route — они общие). */
  sources(): Record<string, unknown>;
  osm(layer: OsmLayer): SourceRef | null;
  contours(): SourceRef;
  /** Частые горизонтали (20 м) — только у векторного пакета. */
  fine(): SourceRef | null;
}

function layerRefs(s: VedarStyleSources, ns: string): LayerRefs {
  if (s.vectorUrl) {
    const id = `vector${ns}`;
    return {
      vector: true,
      sources: () => ({
        [id]: {
          type: 'vector',
          url: s.vectorUrl,
          attribution: `${OSM_ATTRIBUTION} · ${s.attribution}`,
        },
      }),
      osm: (layer) => ({ source: id, 'source-layer': layer }),
      contours: () => ({ source: id, 'source-layer': 'contours' }),
      fine: () => ({ source: id, 'source-layer': 'contours_fine' }),
    };
  }
  return {
    vector: false,
    sources: () => ({ ...contoursSource(s, ns), ...osmSources(s.osmUrls, ns) }),
    osm: (layer) => (s.osmUrls?.[layer] ? { source: `osm-${layer}${ns}` } : null),
    contours: () => ({ source: `contours${ns}` }),
    fine: () => null,
  };
}

/**
 * Собирает style JSON MapLibre. Чистая функция: ни DOM, ни сети — поэтому
 * проверяется тестом целиком, а не «посмотрели глазами один раз».
 *
 * Стиль описывает ОДИН район — тот, что накрывает точку человека. Соседние
 * районы карта подкладывает на ходу через `buildRegionOverlay` (ниже): те же
 * слои с суффиксом района в идентификаторах.
 */
export function buildVedarStyle(
  theme: VedarMapTheme,
  sources: VedarStyleSources,
): Record<string, unknown> {
  const p = PALETTES[theme];
  const glyphs = sources.glyphsUrl || null;
  const font = sources.glyphsFont ?? 'Noto Sans Regular';
  const r = layerRefs(sources, '');
  return {
    version: 8,
    name: `Ведар — ${theme === 'dark' ? 'тёмная' : 'светлая'} топооснова`,
    // Есть глифы — есть подписи; нет — нет и слоя подписей (см. glyphsUrl).
    // Ключ вообще не выставляется, когда его нет: `glyphs: undefined` в
    // объекте стиля MapLibre трактует не как отсутствие, а как значение.
    ...(glyphs ? { glyphs } : {}),
    sources: {
      ...terrainSource(sources, ''),
      // Маршрут и след кладёт компонент: их геометрия приходит из БД и
      // меняется на ходу, стилю о ней знать нечего, кроме вида линии.
      route: { type: 'geojson', data: emptyFeatureCollection() },
      // Линии и площади: один векторный пакет либо GeoJSON по слоям.
      ...r.sources(),
      ...vedarOceanSource(sources, ''),
      ...vedarPlacesSource(sources, ''),
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.background } },
      // Гипсометрия — под всем: цвет высоты, поверх него заливки и тень.
      reliefLayer(p, ''),
      // Океан — сразу над гипсометрией: море там, где берег OSM, а не там,
      // где DEM дал ноль или промолчал.
      ...vedarOceanLayers(sources, p, ''),
      // Заливки ПОД тенью: лес и ледник получают рельеф, вода плоская и так.
      ...osmFillLayers(r, p, ''),
      hillshadeLayer(theme, p, ''),
      ...contourLayers(r, p, glyphs, font, ''),
      // Реки, дороги, тропы — над горизонталями, под линией маршрута: путь
      // человека читается поверх карты, а не сквозь неё.
      ...osmLineLayers(r, p, ''),
      {
        // Свой след — ПОД маршрутом: маршрут — обещание, след — история.
        // Тонкий, голубой, сплошной (это запись, а не обещание пути), без
        // casing. 02.09 без своего слоя он лёг толстым зелёным треком.
        id: 'route-trail',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'kind'], 'trail'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.trail,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 2.5],
          'line-opacity': 0.85,
        },
      },
      // ── Линии маршрута. Вид — по §12, род приходит свойством `kind` от
      // компонента (track / sketch / connector), который сам берёт его из
      // lib/map/line-standard. Стиль НЕ решает род: он его читает, ровно как
      // это устроено на Leaflet-поверхностях.
      //
      // Три СЛОЯ, а не один с выражениями: `line-dasharray` в MapLibre не
      // умеет зависеть от свойства feature (только от зума), и первый живой
      // рендер 02.09 это показал — набросок подборки «Авачинский перевал
      // (база Три вулкана)» (8 точек на 28 км) лёг веером толстых сплошных
      // зелёных линий, то есть предъявил себя как путь, по которому идут.
      // Ровно то, что §12 запрещает. Каждому роду — свой слой со своим
      // пунктиром; подложка (casing) — только у настоящего трека: у пунктира
      // она залила бы просветы и вернула вид трека.
      {
        id: 'route-casing',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'kind'], 'track'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.trackCasing,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 9],
          'line-opacity': 0.55,
        },
      },
      {
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'kind'], 'track'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.track,
          // Зумовое выражение — верхним уровнем: MapLibre не принимает
          // interpolate(['zoom']) внутри case и отвергает стиль целиком
          // (полевой прогон 01.09, «requires a "step" or "interpolate"»).
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5],
          'line-opacity': 0.95,
        },
      },
      {
        // Набросок и импорт: пунктир, приглушённый, 2px (§12). Без casing.
        id: 'route-sketch',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'kind'], 'sketch'],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': p.sketch,
          'line-width': 2,
          'line-dasharray': [4, 3],
          'line-opacity': 0.9,
        },
      },
      {
        // Построение — подход по азимуту, связка: пунктир, серый, 2px (§12).
        // Не путь вовсе, и «Маршрутом» не называется.
        id: 'route-connector',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'kind'], 'connector'],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': p.connector,
          'line-width': 2,
          'line-dasharray': [3, 3],
          'line-opacity': 0.8,
        },
      },
      // Имена воды — под символами: река подписывается вдоль себя, озеро
      // в своём пятне, и оба уступают место ориентирам.
      ...osmWaterLabelLayers(r, p, glyphs, font, ''),
      // Приюты и перевалы — над линиями, под вершинами и посёлками.
      ...osmShelterPassLayers(r, p, glyphs, font, ''),
      // Вершины — сверху всего: ориентир в поле важнее любой линии.
      ...osmPeakLayers(r, p, glyphs, font, ''),
      // Посёлки — самый верх: на обзорном виде это единственное, по чему
      // человек понимает, куда смотрит.
      ...osmPlaceLayers(r, p, glyphs, font, ''),
      // Места платформы — над всем: ради них карту и открывают, а профиль
      // безопасности точки — то, о чём человек в поле спрашивает первым.
      ...vedarPlaceLayers(sources, p, glyphs, font, ''),
    ],
  };
}

/**
 * Ярус подкладки соседнего района (02.09, скрин владельца «карты нет
 * других районов»: при отдалении виден один пакет, остальные девять —
 * чёрные).
 *
 *  - `base`   — рельеф и вершины. Рельеф читается из PMTiles кусками, по
 *               видимым тайлам, и стоит дёшево на любом зуме; вершин в
 *               районе десятки, файл — килобайты.
 *  - `detail` — горизонтали и остальные OSM-слои. Это GeoJSON, и MapLibre
 *               скачивает его ЦЕЛИКОМ: у Эссо 16 МБ горизонталей, у
 *               Кроноцкого 8.6. Десять районов разом на обзорном зуме — это
 *               десятки мегабайт мобильного трафика ради линий, которых на
 *               том зуме всё равно не видно (contour-minor начинается с z11).
 *               Поэтому ярус подкладывается только вблизи (см.
 *               DETAIL_MIN_ZOOM в VedarMap).
 */
/**
 * Адрес файла у каждого источника стиля — чтобы отказ можно было назвать
 * ИМЕНЕМ ФАЙЛА, а не только текстом исключения.
 *
 * Скрин владельца 02.09 из поля: «Своя карта не отрисовалась: Expected ','
 * or ']' after array element in JSON at position 387966». Сообщение верное и
 * бесполезное: под точкой лежит район, а вокруг подкладываются соседние — у
 * каждого горизонтали и семь слоёв OSM, восемьдесят с лишним файлов, и
 * который из них оборвался, из этой строки не следует никак.
 *
 * MapLibre при этом ЗНАЕТ: в событии ошибки едет `sourceId` — его
 * подставляет Style (setEventedParent у менеджера тайлов). Перевод
 * идентификатора в имя файла берётся из самого объекта стиля, а не разбором
 * строки: `osm-paths-south-kamchatka` на дефисы однозначно не делится, и
 * такой разбор врал бы ровно на districts с дефисом в имени.
 */
export function sourceUrlIndex(sources: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, src] of Object.entries(sources ?? {})) {
    if (!src || typeof src !== 'object') continue;
    const s = src as { data?: unknown; url?: unknown };
    // `data` у geojson, `url` у raster-dem поверх pmtiles. Встроенный
    // GeoJSON (источник `route`) — объект, а не адрес: файла у него нет.
    const url = typeof s.data === 'string' ? s.data : typeof s.url === 'string' ? s.url : null;
    if (url) out[id] = url;
  }
  return out;
}

export type RegionTier = 'base' | 'detail';

export interface RegionOverlay {
  sources: Record<string, unknown>;
  layers: Array<Record<string, unknown>>;
}

/**
 * Те же источники и слои, что в основном стиле, но с суффиксом района в
 * идентификаторах — чтобы их можно было добавить на живую карту рядом с
 * уже стоящими. Одни и те же сборщики на оба случая: второй набор правил
 * вида разошёлся бы с первым при следующей правке палитры (§12, тот же
 * урок про три экрана и три правила).
 */
export function buildRegionOverlay(
  theme: VedarMapTheme,
  sources: VedarStyleSources,
  regionId: string,
  tier: RegionTier,
): RegionOverlay {
  const p = PALETTES[theme];
  const glyphs = sources.glyphsUrl || null;
  const ns = `-${regionId}`;
  const font = sources.glyphsFont ?? 'Noto Sans Regular';
  if (tier === 'base') {
    // Вершины и посёлки — два слоя-ориентира, ради которых обзорный вид и
    // нужен. Файлы у обоих килобайтные, в отличие от горизонталей. Векторный
    // пакет — один источник на всё, его тайлы и так берутся по кадру.
    const marks: VedarStyleSources = sources.vectorUrl
      ? sources
      : { ...sources, osmUrls: {
          ...(sources.osmUrls?.peaks ? { peaks: sources.osmUrls.peaks } : {}),
          ...(sources.osmUrls?.places ? { places: sources.osmUrls.places } : {}),
        } };
    const r = layerRefs(marks, ns);
    return {
      sources: {
        ...terrainSource(sources, ns),
        ...(r.vector ? r.sources() : osmSources(marks.osmUrls, ns)),
        ...vedarOceanSource(sources, ns),
        ...vedarPlacesSource(sources, ns),
      },
      layers: [
        reliefLayer(p, ns),
        ...vedarOceanLayers(sources, p, ns),
        hillshadeLayer(theme, p, ns),
        ...osmPeakLayers(r, p, glyphs, font, ns),
        ...osmPlaceLayers(r, p, glyphs, font, ns),
        ...vedarPlaceLayers(sources, p, glyphs, font, ns),
      ] as Array<Record<string, unknown>>,
    };
  }
  const rest: VedarStyleSources['osmUrls'] = { ...(sources.osmUrls ?? {}) };
  delete rest.peaks;
  delete rest.places;
  const r = layerRefs(sources.vectorUrl ? sources : { ...sources, osmUrls: rest }, ns);
  return {
    // Векторный источник уже стоит с базового яруса (карта не добавляет
    // источник дважды — см. VedarMap); повторить его здесь безопасно.
    sources: r.sources(),
    layers: [
      ...osmFillLayers(r, p, ns),
      ...contourLayers(r, p, glyphs, font, ns),
      ...osmLineLayers(r, p, ns),
      ...osmWaterLabelLayers(r, p, glyphs, font, ns),
      ...osmShelterPassLayers(r, p, glyphs, font, ns),
    ] as Array<Record<string, unknown>>,
  };
}

function terrainSource(sources: VedarStyleSources, ns: string): Record<string, unknown> {
  return {
    [`terrain${ns}`]: {
      type: 'raster-dem',
      url: sources.terrainUrl,
      tileSize: 256,
      // Mapbox terrain-RGB: height = -10000 + (R*65536 + G*256 + B) * 0.1
      encoding: 'mapbox',
      maxzoom: sources.terrainMaxZoom,
      attribution: sources.attribution,
    },
  };
}

function contoursSource(sources: VedarStyleSources, ns: string): Record<string, unknown> {
  return {
    [`contours${ns}`]: {
      type: 'geojson',
      data: sources.contoursUrl,
      attribution: sources.attribution,
    },
  };
}

/**
 * Гипсометрическая окраска — слой `color-relief` MapLibre (есть с 5.7, у нас
 * 6.6): цвет считается на клиенте ИЗ ВЫСОТ того же terrain-RGB, что и тень.
 * Ни нового файла, ни пересборки пакета — те же байты, второе прочтение.
 * Ступени — из палитры темы (см. MapPalette.relief).
 */
function reliefLayer(p: MapPalette, ns: string): Record<string, unknown> {
  const stops: Array<number | string> = [];
  for (const [m, color] of p.relief) stops.push(m, color);
  return {
    id: `relief${ns}`,
    type: 'color-relief',
    source: `terrain${ns}`,
    paint: {
      'color-relief-color': ['interpolate', ['linear'], ['elevation'], ...stops],
      'color-relief-opacity': 1,
    },
  };
}

function hillshadeLayer(theme: VedarMapTheme, p: MapPalette, ns: string): Record<string, unknown> {
  return {
    id: `hillshade${ns}`,
    type: 'hillshade',
    source: `terrain${ns}`,
    paint: {
      'hillshade-shadow-color': p.shadow,
      'hillshade-highlight-color': p.highlight,
      'hillshade-accent-color': p.accentShadow,
      // Поверх гипсометрии тень нужна слабее, чем поверх плоского фона:
      // цвет уже несёт высоту, тени остаётся форма склона. На обзорных
      // зумах ещё слабее — там 30-метровый рельеф даёт не форму, а шум.
      'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'],
        8, theme === 'dark' ? 0.35 : 0.2,
        11, theme === 'dark' ? 0.6 : 0.4,
        14, theme === 'dark' ? 0.72 : 0.45],
      'hillshade-illumination-anchor': 'viewport',
      'hillshade-illumination-direction': 315,
    },
  };
}

function contourLayers(
  r: LayerRefs, p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  const c = r.contours();
  const fine = r.fine();
  return [
    // Частые (20 м) — только из векторного пакета и только вблизи: тоньше и
    // бледнее сотенных, чтобы форма склона читалась, а лист не серел.
    ...(fine ? [{
      id: `contour-fine${ns}`,
      type: 'line',
      ...fine,
      filter: ['==', ['get', 'kind'], 'fine'],
      minzoom: 13,
      paint: {
        'line-color': p.contourMinor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.3, 15, 0.6],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.25, 15, 0.5],
      },
    }] : []),
    {
      id: `contour-minor${ns}`,
      type: 'line',
      ...c,
      filter: ['==', ['get', 'kind'], 'minor'],
      // Частые линии на мелком зуме сливаются в кашу — там их нет вовсе.
      minzoom: 11,
      paint: {
        'line-color': p.contourMinor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 14, 0.8],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.35, 13, 0.7],
      },
    },
    {
      id: `contour-major${ns}`,
      type: 'line',
      ...c,
      filter: ['==', ['get', 'kind'], 'major'],
      paint: {
        'line-color': p.contourMajor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 1.4],
        'line-opacity': 0.85,
      },
    },
    // Слой подписей создаётся ТОЛЬКО при наличии глифов. Иначе MapLibre
    // отвергает весь стиль, и человек получает чёрный экран вместо карты.
    ...(glyphs ? [{
      id: `contour-label${ns}`,
      type: 'symbol',
      ...c,
      filter: ['==', ['get', 'kind'], 'major'],
      minzoom: 11,
      layout: {
        'symbol-placement': 'line',
        // Шрифт — тот, что лежит в нашем хранилище (pack-source, PACK_GLYPHS).
        'text-font': [font],
        // Число берётся ИЗ ДАННЫХ. Это и есть разница между картой и
        // картинкой: подпись нельзя «нарисовать похоже».
        'text-field': ['to-string', ['get', 'ele']],
        'text-size': 10,
        'text-max-angle': 25,
        'text-padding': 6,
        'symbol-spacing': 320,
        'text-allow-overlap': false,
        'text-ignore-placement': false,
      },
      paint: {
        'text-color': p.contourLabel,
        'text-halo-color': p.contourLabelHalo,
        'text-halo-width': 1.4,
      },
    }] : []),
  ];
}

/** Источники OSM — только для слоёв, чьи адреса есть. Атрибуция ODbL у каждого. */
function osmSources(urls: VedarStyleSources['osmUrls'], ns: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [layer, url] of Object.entries(urls ?? {})) {
    if (!url) continue;
    out[`osm-${layer}${ns}`] = { type: 'geojson', data: url, attribution: OSM_ATTRIBUTION };
  }
  return out;
}

function osmFillLayers(r: LayerRefs, p: MapPalette, ns: string): unknown[] {
  const out: unknown[] = [];
  // Покрытия — под лесом: лес в OSM часто лежит поверх стланика тем же
  // контуром, и лес честнее. Застройка — ниже всех: она самая грубая.
  const fills: Array<[OsmLayer, string, number]> = [
    ['residential', p.residential, 0.45],
    ['rock', p.rock, 0.45],
    ['sand', p.sand, 0.5],
    ['scrub', p.scrub, 0.45],
    ['wetland', p.wetland, 0.5],
  ];
  for (const [layer, color, opacity] of fills) {
    const ref = r.osm(layer);
    if (!ref) continue;
    out.push({
      id: `osm-${layer}${ns}`, type: 'fill', ...ref,
      paint: { 'fill-color': color, 'fill-opacity': opacity },
    });
  }
  const wood = r.osm('wood');
  if (wood) {
    out.push({
      id: `osm-wood${ns}`, type: 'fill', ...wood,
      paint: { 'fill-color': p.wood, 'fill-opacity': 0.55 },
    });
  }
  const glacier = r.osm('glacier');
  if (glacier) {
    out.push({
      id: `osm-glacier${ns}`, type: 'fill', ...glacier,
      paint: { 'fill-color': p.glacier, 'fill-opacity': 0.7 },
    });
  }
  const water = r.osm('water');
  if (water) {
    out.push({
      id: `osm-water${ns}`, type: 'fill', ...water,
      paint: { 'fill-color': p.water, 'fill-opacity': 0.9 },
    });
  }
  return out;
}

function osmLineLayers(r: LayerRefs, p: MapPalette, ns: string): unknown[] {
  const out: unknown[] = [];
  const waterways = r.osm('waterways');
  const roads = r.osm('roads');
  const paths = r.osm('paths');
  if (waterways) {
    out.push({
      id: `osm-waterways${ns}`, type: 'line', ...waterways,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.waterway,
        // Река шире ручья — по тегу, не по догадке.
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, ['case', ['==', ['get', 'kind'], 'river'], 1.2, 0.6],
          14, ['case', ['==', ['get', 'kind'], 'river'], 2.6, 1.2]],
        'line-opacity': 0.9,
      },
    });
  }
  if (roads) {
    // Обводка (casing) под дорогой — то, чем дорога на карте отличается от
    // ручья того же цвета: у неё есть край. Ширина — по классу дороги.
    const width = ['interpolate', ['linear'], ['zoom'],
      8, ['match', ['get', 'kind'], ['primary', 'trunk'], 1.2, ['secondary', 'tertiary'], 0.9, 0.5],
      14, ['match', ['get', 'kind'], ['primary', 'trunk'], 4, ['secondary', 'tertiary'], 3, 2]];
    out.push({
      id: `osm-roads-casing${ns}`, type: 'line', ...roads,
      minzoom: 10,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.background,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 6],
        'line-opacity': 0.6,
      },
    });
    out.push({
      id: `osm-roads${ns}`, type: 'line', ...roads,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.road,
        'line-width': width,
        'line-opacity': 0.9,
      },
    });
  }
  if (paths) {
    out.push({
      id: `osm-paths${ns}`, type: 'line', ...paths,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': p.path,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 14, 1.8],
        // Тропа с OSM — не наш снятый трек: пунктир, как у всего, что не
        // обещает ведения (§12). Сплошная тёплая линия читалась бы как путь.
        'line-dasharray': [3, 2],
        'line-opacity': 0.9,
      },
    });
  }
  const cliffs = r.osm('cliffs');
  if (cliffs) {
    // Обрыв — линия цвета тревоги, ПОВЕРХ троп: подойти к нему по тропе
    // можно, и линия обязана быть видна раньше, чем край под ногами.
    out.push({
      id: `osm-cliffs${ns}`, type: 'line', ...cliffs,
      minzoom: 11,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': p.cliff,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 14, 2.4],
        'line-opacity': 0.95,
      },
    });
  }
  return out;
}

function osmPeakLayers(
  r: LayerRefs, p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  const peaks = r.osm('peaks');
  if (!peaks) return [];
  const out: unknown[] = [{
    id: `osm-peaks${ns}`, type: 'circle', ...peaks,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4],
      'circle-color': p.peak,
      'circle-stroke-color': p.background,
      'circle-stroke-width': 1,
    },
  }];
  // Имя и высота — только при глифах, иначе слой подписей отвергает стиль
  // целиком (тот же урок, что у горизонталей 01.09).
  if (glyphs) {
    out.push({
      id: `osm-peak-labels${ns}`, type: 'symbol', ...peaks,
      layout: {
        'text-font': [font],
        'text-field': ['case', ['has', 'ele'],
          ['concat', ['get', 'name'], ' ', ['to-string', ['get', 'ele']]],
          ['get', 'name']],
        'text-size': 11,
        'text-offset': [0, 0.9],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': p.peakLabel,
        'text-halo-color': p.background,
        'text-halo-width': 1.4,
      },
    });
  }
  return out;
}

/**
 * Посёлки (02.09, осмотр владельца: «на карте нет ни одного названия»).
 *
 * Слой один на все четыре рода — город, посёлок, село, хутор, — а
 * разбираются они кеглем и ПОРЯДКОМ ВЫТЕСНЕНИЯ (`symbol-sort-key`): когда
 * подписи не помещаются, MapLibre выбрасывает хутор, а не город. Резать
 * зумом по родам было бы четыре слоя и четыре угаданных порога; здесь
 * порог один — «что влезло».
 */
function osmPlaceLayers(
  r: LayerRefs, p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  const places = r.osm('places');
  if (!places) return [];
  const out: unknown[] = [{
    id: `osm-places${ns}`, type: 'circle', ...places,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2, 13, 3.5],
      'circle-color': p.place,
      'circle-stroke-color': p.background,
      'circle-stroke-width': 1,
      'circle-opacity': 0.8,
    },
  }];
  if (glyphs) {
    out.push({
      id: `osm-place-labels${ns}`, type: 'symbol', ...places,
      layout: {
        'text-font': [font],
        'text-field': ['get', 'name'],
        'text-size': ['match', ['get', 'kind'], 'city', 15, 'town', 13, 'village', 12, 11],
        'text-offset': [0, 0.8],
        'text-anchor': 'top',
        'text-padding': 4,
        'text-allow-overlap': false,
        'symbol-sort-key': ['match', ['get', 'kind'], 'city', 0, 'town', 1, 'village', 2, 3],
      },
      paint: {
        'text-color': p.place,
        'text-halo-color': p.background,
        'text-halo-width': 1.6,
      },
    });
  }
  return out;
}

/**
 * Океан обзорного яруса — один GeoJSON, производный от OSM (полигоны суши),
 * потому и атрибуция OSM. Нет адреса — нет ни источника, ни слоя.
 */
function vedarOceanSource(sources: VedarStyleSources, ns: string): Record<string, unknown> {
  if (!sources.oceanUrl) return {};
  return {
    [`vedar-ocean${ns}`]: { type: 'geojson', data: sources.oceanUrl, attribution: OSM_ATTRIBUTION },
  };
}

/**
 * Заливка океана — цветом воды палитры, тем же, что у первой ступени
 * гипсометрии: на стыке ярусов (z7 → z8, где океана уже нет и море красит
 * DEM) цвет не меняется. Непрозрачная: под ней гипсометрия «не знаю»-серого
 * и нулевой высоты, и обе должны уступить берегу OSM.
 */
function vedarOceanLayers(sources: VedarStyleSources, p: MapPalette, ns: string): unknown[] {
  if (!sources.oceanUrl) return [];
  return [{
    id: `vedar-ocean${ns}`, type: 'fill', source: `vedar-ocean${ns}`,
    // Только на обзорных зумах: с z8 клетка читает DEM на полной сетке, и
    // берег в 200 м упрощения лёг бы поверх честного берега по высоте.
    maxzoom: 8,
    paint: { 'fill-color': p.water, 'fill-opacity': 1, 'fill-antialias': true },
  }];
}

/**
 * Источник слоя мест платформы — один GeoJSON на пакет, со своей атрибуцией
 * (наши данные, не OpenStreetMap). Нет адреса — нет источника: слой без
 * файла MapLibre честно не нарисует, но и просить файл, которого нет
 * (PLACES_BUILT), карта не должна.
 */
function vedarPlacesSource(sources: VedarStyleSources, ns: string): Record<string, unknown> {
  if (!sources.placesUrl) return {};
  return {
    [`vedar-places${ns}`]: { type: 'geojson', data: sources.placesUrl, attribution: PLACES_ATTRIBUTION },
  };
}

/**
 * Места платформы (05.09). Точка — факт географии (§9 CLAUDE.md), и на карте
 * она отвечает на один вопрос: «что здесь и чем опасно». Цвет несёт ответ:
 * место с записанными опасностями (`hazard_types` не пуст) — цвет тревоги,
 * тот же, что у обрыва; остальные — цвет вершины, ориентира. Опасность
 * читается из ДАННЫХ профиля, не из типа места: вулкан без профиля не
 * красится тревожным «на всякий случай» — это было бы выдумкой (§4.0).
 *
 * `hazard_types` в свойствах — массив (эндпоинт отдаёт `?? []`); MapLibre
 * держит вложенные значения GeoJSON как есть, и `length` по ним считается.
 * `coalesce` с пустым литералом — на случай объекта без поля вовсе.
 *
 * Круг виден с z6 — на обзоре (z4-7) место читается точкой на фоне
 * рельефа; подпись — с z9, когда есть глифы, и в вытеснении тревожная
 * точка идёт первой: она не должна проигрывать хутору.
 */
function vedarPlaceLayers(
  sources: VedarStyleSources, p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  if (!sources.placesUrl) return [];
  const source = `vedar-places${ns}`;
  const hazardous: unknown = ['>', ['length', ['coalesce', ['get', 'hazard_types'], ['literal', []]]], 0];
  const color: unknown = ['case', hazardous, p.cliff, p.peak];
  const out: unknown[] = [{
    id: `vedar-places${ns}`, type: 'circle', source,
    minzoom: 6,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 13, 5.5],
      'circle-color': color,
      'circle-stroke-color': p.background,
      'circle-stroke-width': 1.2,
      'circle-opacity': 0.95,
    },
  }];
  if (glyphs) {
    out.push({
      id: `vedar-place-labels${ns}`, type: 'symbol', source,
      minzoom: 9,
      layout: {
        'text-font': [font],
        'text-field': ['get', 'name'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 13],
        'text-offset': [0, 0.9],
        'text-anchor': 'top',
        'text-padding': 4,
        'text-allow-overlap': false,
        'symbol-sort-key': ['case', hazardous, 0, 2],
      },
      paint: {
        'text-color': color,
        'text-halo-color': p.background,
        'text-halo-width': 1.6,
      },
    });
  }
  return out;
}

/**
 * Приют и перевал — два ответа, за которыми в поле лезут в карту: где
 * ночевать и где переваливать. Оба видны только вблизи (z10): на обзоре
 * они не решение, а сор.
 *
 * Перевал подписан высотой, как вершина: по ней понимают набор и снег.
 * Безымянный перевал остаётся точкой без подписи — он всё равно факт
 * местности, а выдуманного имени у него нет (§4.0).
 */
function osmShelterPassLayers(
  r: LayerRefs, p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  const out: unknown[] = [];
  const passes = r.osm('passes');
  const shelters = r.osm('shelters');
  const fords = r.osm('fords');
  const springs = r.osm('springs');
  if (fords) {
    // Брод — точка цвета воды с широкой кромкой: на реке она читается как
    // «здесь переходят», не как ещё один изгиб русла.
    out.push({
      id: `osm-fords${ns}`, type: 'circle', ...fords,
      minzoom: 10,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4.5],
        'circle-color': p.waterway,
        'circle-stroke-color': p.background,
        'circle-stroke-width': 2,
      },
    });
  }
  if (springs) {
    // Горячий источник — акцентом: рядом с ним ожог, и он же ориентир.
    out.push({
      id: `osm-springs${ns}`, type: 'circle', ...springs,
      minzoom: 10,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4.5],
        'circle-color': ['case', ['==', ['get', 'kind'], 'hot_spring'], p.hotSpring, p.spring],
        'circle-stroke-color': p.background,
        'circle-stroke-width': 1.5,
      },
    });
  }
  if (passes) {
    out.push({
      id: `osm-passes${ns}`, type: 'circle', ...passes,
      minzoom: 9,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4],
        'circle-color': p.mountainPass,
        'circle-stroke-color': p.background,
        'circle-stroke-width': 1,
      },
    });
  }
  if (shelters) {
    out.push({
      id: `osm-shelters${ns}`, type: 'circle', ...shelters,
      minzoom: 9,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5],
        'circle-color': p.shelter,
        'circle-stroke-color': p.background,
        'circle-stroke-width': 1.5,
      },
    });
  }
  if (!glyphs) return out;
  if (springs) {
    out.push({
      id: `osm-spring-labels${ns}`, type: 'symbol', ...springs,
      minzoom: 12,
      filter: ['has', 'name'],
      layout: {
        'text-font': [font],
        'text-field': ['get', 'name'],
        'text-size': 10,
        'text-offset': [0, 0.9],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': ['case', ['==', ['get', 'kind'], 'hot_spring'], p.hotSpring, p.spring],
        'text-halo-color': p.background,
        'text-halo-width': 1.4,
      },
    });
  }
  if (passes) {
    out.push({
      id: `osm-pass-labels${ns}`, type: 'symbol', ...passes,
      minzoom: 10,
      filter: ['has', 'name'],
      layout: {
        'text-font': [font],
        'text-field': ['case', ['has', 'ele'],
          ['concat', ['get', 'name'], ' ', ['to-string', ['get', 'ele']]],
          ['get', 'name']],
        'text-size': 11,
        'text-offset': [0, 0.9],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': p.mountainPass,
        'text-halo-color': p.background,
        'text-halo-width': 1.4,
      },
    });
  }
  if (shelters) {
    out.push({
      id: `osm-shelter-labels${ns}`, type: 'symbol', ...shelters,
      minzoom: 10,
      filter: ['has', 'name'],
      layout: {
        'text-font': [font],
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-offset': [0, 0.9],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': p.shelter,
        'text-halo-color': p.background,
        'text-halo-width': 1.4,
      },
    });
  }
  return out;
}

/**
 * Имена рек и озёр. Новых данных не нужно: `name` уже лежит в тех же
 * слоях `waterways` и `water` — их писал конвейер с самого начала, а карта
 * не читала. Река подписывается ВДОЛЬ себя (symbol-placement: line), озеро
 * — в своём пятне; безымянные молчат.
 */
function osmWaterLabelLayers(
  r: LayerRefs, p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  if (!glyphs) return [];
  const out: unknown[] = [];
  const waterways = r.osm('waterways');
  const water = r.osm('water');
  if (waterways) {
    out.push({
      id: `osm-waterway-labels${ns}`, type: 'symbol', ...waterways,
      minzoom: 11,
      filter: ['has', 'name'],
      layout: {
        'symbol-placement': 'line',
        'text-font': [font],
        'text-field': ['get', 'name'],
        'text-size': 10,
        'text-max-angle': 30,
        'text-padding': 4,
        'symbol-spacing': 400,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': p.waterLabel,
        'text-halo-color': p.background,
        'text-halo-width': 1.2,
      },
    });
  }
  if (water) {
    out.push({
      id: `osm-water-labels${ns}`, type: 'symbol', ...water,
      minzoom: 10,
      filter: ['has', 'name'],
      layout: {
        'text-font': [font],
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-padding': 4,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': p.waterLabel,
        'text-halo-color': p.background,
        'text-halo-width': 1.2,
      },
    });
  }
  return out;
}

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/** Палитра наружу — для подписей и элементов UI поверх карты. */
export function vedarMapPalette(theme: VedarMapTheme): Readonly<MapPalette> {
  return PALETTES[theme];
}
