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

export type VedarMapTheme = 'dark' | 'light';

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
}

export type OsmLayer =
  | 'water' | 'waterways' | 'wood' | 'glacier' | 'paths' | 'roads' | 'peaks'
  | 'places' | 'shelters' | 'passes';
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

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
  return {
    version: 8,
    name: `Ведар — ${theme === 'dark' ? 'тёмная' : 'светлая'} топооснова`,
    // Есть глифы — есть подписи; нет — нет и слоя подписей (см. glyphsUrl).
    // Ключ вообще не выставляется, когда его нет: `glyphs: undefined` в
    // объекте стиля MapLibre трактует не как отсутствие, а как значение.
    ...(glyphs ? { glyphs } : {}),
    sources: {
      ...terrainSource(sources, ''),
      ...contoursSource(sources, ''),
      // Маршрут и след кладёт компонент: их геометрия приходит из БД и
      // меняется на ходу, стилю о ней знать нечего, кроме вида линии.
      route: { type: 'geojson', data: emptyFeatureCollection() },
      // OSM-слои — по одному источнику на слой, только те, что есть у района.
      ...osmSources(sources.osmUrls, ''),
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.background } },
      // Заливки ПОД тенью: лес и ледник получают рельеф, вода плоская и так.
      ...osmFillLayers(sources.osmUrls, p, ''),
      hillshadeLayer(theme, p, ''),
      ...contourLayers(sources, p, glyphs, ''),
      // Реки, дороги, тропы — над горизонталями, под линией маршрута: путь
      // человека читается поверх карты, а не сквозь неё.
      ...osmLineLayers(sources.osmUrls, p, ''),
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
      ...osmWaterLabelLayers(sources.osmUrls, p, glyphs, sources.glyphsFont ?? 'Noto Sans Regular', ''),
      // Приюты и перевалы — над линиями, под вершинами и посёлками.
      ...osmShelterPassLayers(sources.osmUrls, p, glyphs, sources.glyphsFont ?? 'Noto Sans Regular', ''),
      // Вершины — сверху всего: ориентир в поле важнее любой линии.
      ...osmPeakLayers(sources.osmUrls, p, glyphs, sources.glyphsFont ?? 'Noto Sans Regular', ''),
      // Посёлки — самый верх: на обзорном виде это единственное, по чему
      // человек понимает, куда смотрит.
      ...osmPlaceLayers(sources.osmUrls, p, glyphs, sources.glyphsFont ?? 'Noto Sans Regular', ''),
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
    // нужен. Файлы у обоих килобайтные, в отличие от горизонталей.
    const marks: VedarStyleSources['osmUrls'] = {};
    if (sources.osmUrls?.peaks) marks.peaks = sources.osmUrls.peaks;
    if (sources.osmUrls?.places) marks.places = sources.osmUrls.places;
    return {
      sources: { ...terrainSource(sources, ns), ...osmSources(marks, ns) },
      layers: [
        hillshadeLayer(theme, p, ns),
        ...osmPeakLayers(marks, p, glyphs, font, ns),
        ...osmPlaceLayers(marks, p, glyphs, font, ns),
      ] as Array<Record<string, unknown>>,
    };
  }
  const rest: VedarStyleSources['osmUrls'] = { ...(sources.osmUrls ?? {}) };
  delete rest.peaks;
  delete rest.places;
  return {
    sources: { ...contoursSource(sources, ns), ...osmSources(rest, ns) },
    layers: [
      ...osmFillLayers(rest, p, ns),
      ...contourLayers(sources, p, glyphs, ns),
      ...osmLineLayers(rest, p, ns),
      ...osmWaterLabelLayers(rest, p, glyphs, font, ns),
      ...osmShelterPassLayers(rest, p, glyphs, font, ns),
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

function hillshadeLayer(theme: VedarMapTheme, p: MapPalette, ns: string): Record<string, unknown> {
  return {
    id: `hillshade${ns}`,
    type: 'hillshade',
    source: `terrain${ns}`,
    paint: {
      'hillshade-shadow-color': p.shadow,
      'hillshade-highlight-color': p.highlight,
      'hillshade-accent-color': p.accentShadow,
      'hillshade-exaggeration': theme === 'dark' ? 0.72 : 0.45,
      'hillshade-illumination-anchor': 'viewport',
      'hillshade-illumination-direction': 315,
    },
  };
}

function contourLayers(
  sources: VedarStyleSources, p: MapPalette, glyphs: string | null, ns: string,
): unknown[] {
  return [
    {
      id: `contour-minor${ns}`,
      type: 'line',
      source: `contours${ns}`,
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
      source: `contours${ns}`,
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
      source: `contours${ns}`,
      filter: ['==', ['get', 'kind'], 'major'],
      minzoom: 11,
      layout: {
        'symbol-placement': 'line',
        // Шрифт — тот, что лежит в нашем хранилище (pack-source, PACK_GLYPHS).
        'text-font': [sources.glyphsFont ?? 'Noto Sans Regular'],
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

function osmFillLayers(urls: VedarStyleSources['osmUrls'], p: MapPalette, ns: string): unknown[] {
  const out: unknown[] = [];
  if (urls?.wood) {
    out.push({
      id: `osm-wood${ns}`, type: 'fill', source: `osm-wood${ns}`,
      paint: { 'fill-color': p.wood, 'fill-opacity': 0.55 },
    });
  }
  if (urls?.glacier) {
    out.push({
      id: `osm-glacier${ns}`, type: 'fill', source: `osm-glacier${ns}`,
      paint: { 'fill-color': p.glacier, 'fill-opacity': 0.7 },
    });
  }
  if (urls?.water) {
    out.push({
      id: `osm-water${ns}`, type: 'fill', source: `osm-water${ns}`,
      paint: { 'fill-color': p.water, 'fill-opacity': 0.9 },
    });
  }
  return out;
}

function osmLineLayers(urls: VedarStyleSources['osmUrls'], p: MapPalette, ns: string): unknown[] {
  const out: unknown[] = [];
  if (urls?.waterways) {
    out.push({
      id: `osm-waterways${ns}`, type: 'line', source: `osm-waterways${ns}`,
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
  if (urls?.roads) {
    out.push({
      id: `osm-roads${ns}`, type: 'line', source: `osm-roads${ns}`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.road,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 2.2],
        'line-opacity': 0.85,
      },
    });
  }
  if (urls?.paths) {
    out.push({
      id: `osm-paths${ns}`, type: 'line', source: `osm-paths${ns}`,
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
  return out;
}

function osmPeakLayers(
  urls: VedarStyleSources['osmUrls'], p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  if (!urls?.peaks) return [];
  const out: unknown[] = [{
    id: `osm-peaks${ns}`, type: 'circle', source: `osm-peaks${ns}`,
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
      id: `osm-peak-labels${ns}`, type: 'symbol', source: `osm-peaks${ns}`,
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
  urls: VedarStyleSources['osmUrls'], p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  if (!urls?.places) return [];
  const out: unknown[] = [{
    id: `osm-places${ns}`, type: 'circle', source: `osm-places${ns}`,
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
      id: `osm-place-labels${ns}`, type: 'symbol', source: `osm-places${ns}`,
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
 * Приют и перевал — два ответа, за которыми в поле лезут в карту: где
 * ночевать и где переваливать. Оба видны только вблизи (z10): на обзоре
 * они не решение, а сор.
 *
 * Перевал подписан высотой, как вершина: по ней понимают набор и снег.
 * Безымянный перевал остаётся точкой без подписи — он всё равно факт
 * местности, а выдуманного имени у него нет (§4.0).
 */
function osmShelterPassLayers(
  urls: VedarStyleSources['osmUrls'], p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  const out: unknown[] = [];
  if (urls?.passes) {
    out.push({
      id: `osm-passes${ns}`, type: 'circle', source: `osm-passes${ns}`,
      minzoom: 9,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4],
        'circle-color': p.mountainPass,
        'circle-stroke-color': p.background,
        'circle-stroke-width': 1,
      },
    });
  }
  if (urls?.shelters) {
    out.push({
      id: `osm-shelters${ns}`, type: 'circle', source: `osm-shelters${ns}`,
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
  if (urls?.passes) {
    out.push({
      id: `osm-pass-labels${ns}`, type: 'symbol', source: `osm-passes${ns}`,
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
  if (urls?.shelters) {
    out.push({
      id: `osm-shelter-labels${ns}`, type: 'symbol', source: `osm-shelters${ns}`,
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
  urls: VedarStyleSources['osmUrls'], p: MapPalette, glyphs: string | null, font: string, ns: string,
): unknown[] {
  if (!glyphs) return [];
  const out: unknown[] = [];
  if (urls?.waterways) {
    out.push({
      id: `osm-waterway-labels${ns}`, type: 'symbol', source: `osm-waterways${ns}`,
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
  if (urls?.water) {
    out.push({
      id: `osm-water-labels${ns}`, type: 'symbol', source: `osm-water${ns}`,
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
