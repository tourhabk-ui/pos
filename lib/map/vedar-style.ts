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
  /** Построение — подход по азимуту, связка (§12, connectorLine). */
  connector: string;
}

const PALETTES: Record<VedarMapTheme, MapPalette> = {
  // Тёмная — та, что на референсе владельца 31.08. Полевой контур уже
  // тёмный по решению владельца 2026-08-15 (§2, «тёмные экраны полевого
  // контура»), так что это не новая эстетика, а продолжение принятой.
  dark: {
    background: '#0D1117',   // --bg-primary dark
    shadow: '#05070A',
    highlight: '#2A3B33',
    accentShadow: '#0A1512',
    contourMinor: '#3D5147',
    contourMajor: '#6E8B7A',
    contourLabel: '#8B949E', // --text-secondary dark
    contourLabelHalo: '#0D1117',
    track: '#3FB950',        // --success
    trackCasing: '#0D1117',
    connector: '#8B949E',
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
    connector: '#6B6560',
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
}

/**
 * Собирает style JSON MapLibre. Чистая функция: ни DOM, ни сети — поэтому
 * проверяется тестом целиком, а не «посмотрели глазами один раз».
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
      terrain: {
        type: 'raster-dem',
        url: sources.terrainUrl,
        tileSize: 256,
        // Mapbox terrain-RGB: height = -10000 + (R*65536 + G*256 + B) * 0.1
        encoding: 'mapbox',
        maxzoom: sources.terrainMaxZoom,
        attribution: sources.attribution,
      },
      contours: {
        type: 'geojson',
        data: sources.contoursUrl,
        attribution: sources.attribution,
      },
      // Маршрут и след кладёт компонент: их геометрия приходит из БД и
      // меняется на ходу, стилю о ней знать нечего, кроме вида линии.
      route: { type: 'geojson', data: emptyFeatureCollection() },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.background } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'terrain',
        paint: {
          'hillshade-shadow-color': p.shadow,
          'hillshade-highlight-color': p.highlight,
          'hillshade-accent-color': p.accentShadow,
          'hillshade-exaggeration': theme === 'dark' ? 0.72 : 0.45,
          'hillshade-illumination-anchor': 'viewport',
          'hillshade-illumination-direction': 315,
        },
      },
      {
        id: 'contour-minor',
        type: 'line',
        source: 'contours',
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
        id: 'contour-major',
        type: 'line',
        source: 'contours',
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
        id: 'contour-label',
        type: 'symbol',
        source: 'contours',
        filter: ['==', ['get', 'kind'], 'major'],
        minzoom: 11,
        layout: {
          'symbol-placement': 'line',
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
      // ── Линия маршрута. Вид — по §12, род приходит в свойстве `fidelity`
      // от lib/map/line-standard: снятый трек сплошной и уверенный, набросок
      // и импорт — пунктиром, построение — серым. Стиль НЕ решает род сам:
      // он его читает, ровно как это устроено на Leaflet-поверхностях.
      {
        id: 'route-casing',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'connector'], false],
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
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'case', ['get', 'connector'], p.connector, p.track,
          ],
          'line-width': [
            'case', ['get', 'connector'],
            2,
            ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5],
          ],
          // Пунктир ставит компонент через line-dasharray на основе
          // dashArray из line-standard — здесь только сплошная основа.
          'line-opacity': ['case', ['get', 'connector'], 0.75, 0.95],
        },
      },
    ],
  };
}

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/** Палитра наружу — для подписей и элементов UI поверх карты. */
export function vedarMapPalette(theme: VedarMapTheme): Readonly<MapPalette> {
  return PALETTES[theme];
}
