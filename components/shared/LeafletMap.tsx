'use client';

import { useEffect, useRef, useState } from 'react';
import type { Map as LMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

export { MarkerType } from '@/components/shared/leaflet-types';
export type { MapMarkerGeometry, MapMarker } from '@/components/shared/leaflet-types';
import type { MapMarker, MapMarkerGeometry } from '@/components/shared/leaflet-types';
import { placeMarkerSvg } from '@/lib/map/place-marker-icons';

interface LeafletMapProps {
  markers?: MapMarker[];
  center?: [number, number];
  zoom?: number;
  height?: string;
  className?: string;
  attribution?: boolean;
  /**
   * Угол атрибуции — по умолчанию Leaflet ставит её bottomright, и это
   * правильно почти везде. Но там, где сверху лежит непрозрачная панель
   * до самого низа (экран «На маршруте», _PlanningClient: нижний лист
   * приборов, fixed inset-x-0 bottom-0, минимум 32vh) — bottomright МЁРТВ,
   * атрибуция OpenStreetMap лежит в контроле честно, а на экране её не
   * видно никогда (04.09, проверка владельца — тот же разрыв нашёлся у
   * VedarMap с тем же диагнозом). Явный угол — способ вызывающего сказать
   * «здесь низ занят», не трогая остальные семь поверхностей с Leaflet.
   */
  attributionPosition?: 'topleft' | 'topright' | 'bottomleft' | 'bottomright';
  onMarkerClick?: (id: string) => void;
  /**
   * Тап по свободной точке карты — сырые координаты под пальцем, не
   * привязанные к маркеру (владелец 27.08: клик создаёт `coordinate`
   * цель — lib/on-route/destination.ts). Leaflet зовёт это на КАЖДЫЙ
   * клик по карте, включая клик по маркеру/попапу — потребитель решает,
   * что с этим делать.
   */
  onMapClick?: (lat: number, lng: number) => void;
  /** Показать позицию пользователя (синяя точка) — работает через GPS без интернета */
  showUserLocation?: boolean;
  /** Высота приоритета: «battery» (экономит батарею) или «highAccuracy» (максимум точности) */
  locationPriority?: 'battery' | 'highAccuracy';
  /**
   * Пережить ремонт карты — иначе первый фикс каждый раз «первый».
   *
   * `isFirstFix` внутри watchPosition верно определяет момент центрирования
   * ОДИН РАЗ на всё время жизни ЭТОГО инстанса Leaflet-карты (фикс 30.08:
   * «карта скачет» при шумном GPS). Но полноэкранный режим «Карта» держит
   * markers с живым составом (след, подход к тропе — см. mapMarkers в
   * _PlanningClient.tsx), и при КАЖДОЙ смене identity этого массива весь
   * компонент ниже размонтируется и создаётся заново — `userMarker` снова
   * `null`, `isFirstFix` снова `true`, камера снова дёргается к точке. Живой
   * скрин владельца 31.08 сразу после применения настоящего трека к
   * «Зеленовским озеркам»: «линя встала но карта скачет» — тот же механизм,
   * просто добрался до полноэкранного режима, которого не касался фикс от
   * 30.08 (тот правил только сам watchPosition, не пережитие ремонта).
   *
   * Ref живёт у ВЫЗЫВАЮЩЕГО компонента, который не размонтируется на каждый
   * GPS-тик, — поэтому переживает ремонт LeafletMap внутри себя. Не
   * передан — поведение как раньше (центрирует один раз за жизнь инстанса).
   */
  autoPanDoneRef?: { current: boolean };
}

const COLOR_MAP: Record<string, string> = {
  red:       '#DC2626',
  blue:      '#2568B0',
  green:     '#3FB950',
  orange:    '#D44A0C',
  purple:    '#8B5CF6',
  darkBlue:  '#1E40AF',
  darkCyan:  '#0891B2',
  lightBlue: '#38BDF8',
  darkGreen: '#15803D',
  teal:      '#0D9488',
  brown:     '#92400E',
  gray:      '#6B7280',
  darkOrange:'#C2410C',
  cyan:      '#06B6D4',
};

/**
 * Цвет маркера/линии — из COLOR_MAP по имени либо хекс как есть.
 *
 * `lib/map/line-standard.ts` (`trackLine()`/`connectorLine()`) отдаёт цвет
 * УЖЕ хексом (`#4ade80`, `#9A9590` — §12 «линия называет своё
 * происхождение»). Прежний код искал этот хекс в COLOR_MAP как ключ, не
 * находил и всегда откатывался на дефолт: набросок и снятый трек, зелёный и
 * серый по стандарту, рисовались одинаковым teal — стандарт был мёртв на
 * каждом экране, который через LeafletMap его применял (карточка маршрута,
 * планер, паспорт маршрута).
 */
function resolveColor(color: string | undefined | null, fallback: string): string {
  if (color) {
    if (color.startsWith('#')) return color;
    const named = COLOR_MAP[color];
    if (named) return named;
  }
  return COLOR_MAP[fallback] ?? fallback;
}

/** Попап собирается строкой — любой текст из БД обязан быть экранирован. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** «2 часа назад» / «3 дня назад» — возраст данных об ограничениях. */
function ageLabel(ts: number): string {
  const hours = Math.floor((Date.now() - ts) / 3_600_000);
  if (hours < 1) return 'только что';
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

function buildPopupHtml(marker: MapMarker): string {
  const hex = resolveColor(marker.color, 'blue');
  let html = `<div style="font-family:sans-serif;max-width:220px">`;
  html += `<strong style="font-size:13px;color:#111;display:block;margin-bottom:4px">${escapeHtml(marker.title)}</strong>`;
  // Ограничения — ПЕРЕД описанием: в поле «дорога закрыта» важнее рассказа
  // о красотах места (issue #836).
  if (marker.restrictions && marker.restrictions.length > 0) {
    const age = marker.restrictionsAt ? ` · данные ${ageLabel(marker.restrictionsAt)}` : '';
    html += `<div style="margin:0 0 6px;padding:6px 8px;border-radius:6px;background:#FEF2F2;border:1px solid #FCA5A5">`;
    html += `<span style="display:block;color:#B91C1C;font-size:11px;font-weight:700;margin-bottom:2px">Ограничения${escapeHtml(age)}</span>`;
    html += `<span style="color:#7F1D1D;font-size:11px;line-height:1.35">${marker.restrictions.map(escapeHtml).join('; ')}</span>`;
    html += `</div>`;
  }
  if (marker.description) {
    html += `<span style="color:#555;font-size:12px;line-height:1.4">${escapeHtml(marker.description)}</span>`;
  }
  if (marker.href) {
    html += `<a href="${marker.href}" style="color:${hex};font-size:12px;font-weight:600;text-decoration:none;display:inline-block;margin-top:6px">Смотреть маршрут →</a>`;
  }
  html += `</div>`;
  return html;
}

/**
 * Иконки маркеров по типу локации. Вынесены из тела эффекта на уровень
 * модуля: с разделением жизненного цикла карты и отрисовки слоёв (31.08)
 * набор строится на каждую перерисовку маркеров, а не раз на создание
 * карты, и держать сотню килобайт SVG-литералов внутри цикла незачем.
 * Содержимое не менялось — только место.
 */
export default function LeafletMap({
  markers = [],
  center = [53.0444, 158.6483],
  zoom = 8,
  height = '400px',
  className = '',
  // OSM требует видимую атрибуцию НА КАЖДОЙ карте, использующей их тайлы —
  // это не опция удобства (владелец 28.08, M0-безопасность). `false` был
  // дефолтом — три реальных экрана полагались на него молча и показывали
  // карту без атрибуции. Теперь по умолчанию атрибуция ВКЛЮЧЕНА; `false`
  // остаётся явным, осознанным выключением для мест, где атрибуция даётся
  // иначе (не через это проп).
  attribution = true,
  attributionPosition,
  onMarkerClick,
  onMapClick,
  showUserLocation = false,
  locationPriority = 'highAccuracy',
  autoPanDoneRef,
}: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LMap | null>(null);
  const clusterRef = useRef<unknown>(null);
  /**
   * Вид карты переживает НЕПРОШЕНЫЙ ремонт инстанса.
   *
   * «линя встала но карта скачет» (владелец 31.08, полевой прогон) — и это
   * оказался не panTo. Эффект ниже держит ВЕСЬ инстанс карты и пересоздаёт
   * его при смене identity `markers`: `map.remove()`, новый `L.map(...)` с
   * center/zoom ИЗ ПРОПОВ, затем `fitBounds` по всем маркерам — и ещё
   * дважды, через requestAnimationFrame и setTimeout(250). В полноэкранном
   * режиме `markers` меняется на КАЖДОМ GPS-фиксе (в наборе живой след и
   * линия подхода), поэтому каждый фикс сбрасывал вид туда, где человек его
   * не оставлял: приблизился — отскочило, отвёл в сторону — вернуло.
   * Отличить это от panTo глазом нельзя, а причина другая и лечится другим.
   *
   * Ремонт бывает двух родов, и путать их нельзя:
   *  - ПРОШЕНЫЙ — сменились center/zoom в пропах (кнопка «Карта», выбор
   *    маршрута). Тогда новый вид и есть смысл действия: ставим из пропов и
   *    подгоняем fitBounds, как раньше.
   *  - НЕПРОШЕНЫЙ — пропы вида те же, а инстанс всё равно пересоздаётся
   *    из-за маркеров. Тогда вид восстанавливается тот, что был у человека
   *    на экране, и fitBounds НЕ зовётся: он бы отменил восстановление.
   */
  const viewRef = useRef<{ lat: number; lng: number; zoom: number } | null>(null);
  const viewPropsRef = useRef<string>('');
  /**
   * Слои маркеров живут ОТДЕЛЬНО от самой карты.
   *
   * Продолжение того же разбора 31.08 («она как скакала так и скачет» — вид
   * восстанавливать оказалось мало). Пока создание карты и отрисовка маркеров
   * сидели в ОДНОМ эффекте с `markers` в зависимостях, каждое обновление
   * набора точек означало `map.remove()` и сборку карты заново: новый DOM,
   * новый тайловый слой, повторная загрузка тайлов. В полноэкранном режиме
   * набор меняется на каждом GPS-фиксе (живой след, линия подхода) — то есть
   * карта под рукой человека полностью перезагружалась каждые несколько
   * секунд. Восстановленный вид убирает прыжок координат, но не мигание и не
   * перекачку тайлов на мобильной связи.
   *
   * Побочно это чинило само себя ещё в одном месте: синяя точка «Я здесь»
   * тоже пересоздавалась на каждом ремонте, поэтому CSS-transition на её
   * transform (правка выше по файлу) не мог ничего сгладить — элемент был
   * каждый раз НОВЫЙ, а transition работает только на живущем элементе.
   * Теперь маркер переживает обновление набора, и сглаживание наконец
   * действует. И GPS-watch больше не перезапускается на каждый набор: он
   * стоит в эффекте жизненного цикла, а не рядом с маркерами.
   *
   * Разделение: эффект жизненного цикла (карта, тайлы, кластер, GPS, ресайз)
   * зависит только от вида и режима; эффект маркеров снимает прежние слои и
   * рисует новые НА ЖИВОЙ карте.
   */
  const LRef = useRef<typeof import('leaflet') | null>(null);
  const drawnRef = useRef<Array<{ remove: () => void }>>([]);
  const fitDoneRef = useRef(false);
  // Обработчики — через ref: инлайновая стрелка у вызывающего меняет identity
  // на каждом рендере, и будь она в зависимостях, карта пересоздавалась бы
  // вообще на каждый рендер родителя, независимо от маркеров.
  const onMarkerClickRef = useRef(onMarkerClick);
  const onMapClickRef = useRef(onMapClick);
  onMarkerClickRef.current = onMarkerClick;
  onMapClickRef.current = onMapClick;
  // Счётчик готовности карты — сигнал эффекту маркеров, что рисовать есть на
  // чём. Меняется при КАЖДОМ создании карты, поэтому маркеры перерисовываются
  // на новом инстансе, а не теряются.
  const [mapEpoch, setMapEpoch] = useState(0);
  /**
   * Карта не завелась — это надо СКАЗАТЬ.
   *
   * Инициализация падала в пустой `catch`, и при неудачной загрузке куска
   * leaflet человек получал ровно чёрный прямоугольник: ни карты, ни ошибки,
   * ни причины (владелец 09.08: «по кнопке карта открывается чёрный экран»).
   * На экране навигации это худший из возможных ответов — он неотличим от
   * «приложение умерло», и проверить нечего.
   */
  const [initFailed, setInitFailed] = useState(false);
  /**
   * Какая именно стадия не завелась — владелец 28.08 (M0-безопасность):
   * «карта не загрузилась» раньше был один текст на четыре разные причины
   * (не загрузился модуль leaflet, не загрузился markercluster, упала сама
   * инициализация карты, не отдались тайлы) — падение шло в console.error
   * по коду, БЕЗ сырых координат человека, только стадия.
   */
  const [mapErrorCode, setMapErrorCode] = useState<
    'leaflet_import' | 'cluster_import' | 'map_init' | null
  >(null);
  const [retry, setRetry] = useState(0);
  /**
   * Своего положения нет, и это сказано вслух.
   *
   * Отказ геолокации глотался пустым обработчиком, а синяя точка при этом
   * стояла в центре карты с первого кадра. Человек видел «себя» там, где его
   * нет, и никакой разницы между «GPS не дал фикса» и «вот вы» на экране не
   * было.
   */
  const [geoDenied, setGeoDenied] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    // Считается СИНХРОННО, до async-тела: cleanup предыдущего прогона уже
    // отработал и положил в viewRef вид, который человек видел последним.
    const viewPropsKey = `${center[0]},${center[1]},${zoom}`;
    const deliberateView = viewPropsRef.current !== viewPropsKey;
    viewPropsRef.current = viewPropsKey;
    // Первый монтаж (viewRef пуст) тоже идёт по ветке пропов — восстанавливать
    // нечего, и fitBounds там законен.
    const restoredView = deliberateView ? null : viewRef.current;

    // Watch ID для GPS — вынесен наверх, чтобы доступный в cleanup()
    let userLocationWatchId: number | null = null;
    // Tile error overlay — вынесен наверх чтобы cleanup мог его удалить
    let errorOverlay: HTMLDivElement | null = null;
    // ResizeObserver — вынесен наверх, чтобы cleanup его отключил
    let resizeObserver: ResizeObserver | null = null;

    // Dynamic import — leaflet + markercluster, СТАДИИ РАЗДЕЛЬНО (M0-4,
    // владелец 28.08): один общий .catch() на Promise.all не различал,
    // какая из трёх вещей не завелась — импорт leaflet, импорт плагина
    // кластеров или сама инициализация карты (map = L.map(...), тайлы,
    // маркеры). Раздельные try/catch дают код стадии в mapErrorCode.
    let cancelled = false;
    (async () => {
      let L: typeof import('leaflet');
      try {
        L = await import('leaflet');
      } catch (err) {
        if (cancelled) return;
        console.error('[LeafletMap] init failed', { code: 'leaflet_import' }, err);
        setMapErrorCode('leaflet_import');
        setInitFailed(true);
        return;
      }
      try {
        await import('leaflet.markercluster');
      } catch (err) {
        if (cancelled) return;
        console.error('[LeafletMap] init failed', { code: 'cluster_import' }, err);
        setMapErrorCode('cluster_import');
        setInitFailed(true);
        return;
      }
      if (cancelled || !containerRef.current) return;

      try {
      // Уничтожаем предыдущую карту
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        clusterRef.current = null;
      }

      // Leaflet throws "Map container is already initialized" if the container
      // has a _leaflet_id from a previous init that wasn't cleaned up
      // (e.g., prior render threw before mapRef.current was set).
      // Clearing the property lets Leaflet re-initialize the container safely.
      const container = containerRef.current as HTMLElement & { _leaflet_id?: number };
      delete container._leaflet_id;

      const map = L.map(containerRef.current, {
        center: restoredView
          ? L.latLng(restoredView.lat, restoredView.lng)
          : L.latLng(center[0], center[1]),
        zoom: restoredView ? restoredView.zoom : zoom,
        zoomControl: false,
        // Свой угол — свой контрол ниже (иначе Leaflet ставит его
        // bottomright и никакая опция map() этот угол не меняет).
        attributionControl: attribution !== false && !attributionPosition,
        minZoom: 5,
        // Совпадает с maxZoom тайлового слоя ниже (17) — владелец 28.08,
        // закрытие M0. Было 12: карта искусственно запрещала приближение,
        // хотя источник тайлов отдаёт вплоть до 17-го зума — полевая карта
        // не могла показать то, что уже умел показать её собственный слой.
        maxZoom: 17,
        maxBounds: L.latLngBounds(
          L.latLng(48.0, 153.0),
          L.latLng(64.0, 178.0)
        ),
        maxBoundsViscosity: 1.0,
      });

      // Store immediately so cleanup always finds and removes this map,
      // even if later code (markerClusterGroup, GPS setup) throws.
      mapRef.current = map;

      // Глобальный фикс: маркеры ВСЕГДА поверх тайлов (z-index > tilePane=400)
      if (!document.getElementById('kh-marker-zfix')) {
        const s = document.createElement('style');
        s.id = 'kh-marker-zfix';
        s.textContent = `
          .leaflet-marker-pane, .leaflet-popup-pane, .leaflet-tooltip-pane { z-index: 1000 !important; }
          .leaflet-overlay-pane { z-index: 400 !important; }
          /**
           * Синяя точка «Я здесь» плавно скользит к новому фиксу, а не
           * телепортируется. userMarker.setLatLng() зовётся на КАЖДЫЙ сырой
           * GPS-фикс без сглаживания (гасить его дистанционным порогом
           * нельзя — на машине реальный проезд между фиксами и есть те же
           * десятки метров, что и шум в помещении, отличить одно от другого
           * расстоянием невозможно). Leaflet двигает divIcon через
           * transform: translate3d(...) на .leaflet-marker-icon — CSS
           * transition на этом transform превращает каждый скачок точности
           * (±46 м и хуже, живой скрин владельца 31.08: «карта скачет») в
           * плавный проезд за время до следующего фикса, а не дёрганье.
           * Компаса и панорамирования камеры это не касается — только сам
           * маркер, чтобы визуально не пропадал момент реального движения.
           */
          .kh-user-location { transition: transform 0.6s ease-out; }
        `;
        document.head.appendChild(s);
      }

      // Zoom-контролы — справа вверху, чтобы не перекрывать фильтры снизу
      L.control.zoom({ position: 'topright' }).addTo(map);

      // Свой угол атрибуции (см. attributionPosition выше) — заменяет
      // отключённый встроенный контрол, тем же текстом.
      if (attribution !== false && attributionPosition) {
        L.control.attribution({
          position: attributionPosition,
          prefix: false,
        }).addTo(map);
      }

      // Через ref: обработчик вызывающего меняет identity на каждом рендере
      // (инлайновая стрелка), а карта из-за этого пересоздаваться не должна.
      map.on('click', (e) => onMapClickRef.current?.(e.latlng.lat, e.latlng.lng));

      // Базовый слой тайлов с авто-фолбэком. Раньше был единственный хост
      // (.cz-зеркало OpenTopoMap) — когда он лёг, карта превращалась в пустой
      // фон. Теперь при серии ошибок тайлов переключаемся на следующий источник,
      // а оверлей "карта недоступна" показываем только если лёг ПОСЛЕДНИЙ.
      // Оба источника — без ключа; OSM широко доступен из РФ (primary),
      // OpenTopoMap — топографический запасной.
      const TILE_URLS = [
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      ];
      let sourceIdx = 0;
      let tileErrors = 0;
      const tileLayer = L.tileLayer(TILE_URLS[0], {
        maxZoom: 17,
        attribution: attribution !== false ? '© OpenStreetMap | OpenTopoMap (CC-BY-SA)' : '',
      }).addTo(map);
      tileLayer.on('tileerror', () => {
        tileErrors++;
        if (tileErrors < 4) return;
        // Есть ещё непробованный источник — молча переключаемся на него
        if (sourceIdx < TILE_URLS.length - 1) {
          sourceIdx++;
          tileErrors = 0;
          tileLayer.setUrl(TILE_URLS[sourceIdx]);
          return;
        }
        // Все источники исчерпаны — оверлей (GPS всё равно работает).
        // Код стадии — тот же язык диагностики, что у leaflet_import/
        // cluster_import/map_init (M0-4): это четвёртая, отдельная причина
        // «карта не загрузилась», не смешанная с остальными тремя.
        console.error('[LeafletMap] init failed', { code: 'tile_unavailable' });
        if (!errorOverlay && containerRef.current) {
          errorOverlay = document.createElement('div');
          errorOverlay.style.cssText =
            'position:absolute;top:0;left:0;right:0;bottom:0;' +
            'display:flex;align-items:center;justify-content:center;' +
            'background:rgba(13,17,23,0.82);z-index:1000;border-radius:inherit;pointer-events:none;';
          errorOverlay.innerHTML =
            '<div style="text-align:center;padding:20px;color:#8b949e">' +
            '<div style="font-size:13px;font-weight:700;color:#f0f6fc;margin-bottom:6px">Карта недоступна</div>' +
            '<div style="font-size:12px;line-height:1.5">GPS работает — координаты активны.<br>Тайлы карты не загружаются.</div>' +
            '</div>';
          containerRef.current.style.position = 'relative';
          containerRef.current.appendChild(errorOverlay);
        }
      });

      // Группа кластеров — try/catch: leaflet.markercluster может не успеть
      // расширить L при dynamic import / module cache split.
      let clusterGroup: InstanceType<typeof L.MarkerClusterGroup> | null = null;
      try {
        clusterGroup = L.markerClusterGroup({
          chunkedLoading: true,
          chunkInterval: 200,
          chunkDelay: 50,
          maxClusterRadius: 60,
          spiderfyOnMaxZoom: true,
          showCoverageOnHover: false,
          zoomToBoundsOnClick: true,
          disableClusteringAtZoom: 11,
          iconCreateFunction: (cluster: InstanceType<typeof L.MarkerCluster>) => {
            const count = cluster.getChildCount();
            let size: 'small' | 'medium' | 'large' = 'small';
            let bgColor = '#0f172a';

              if (count >= 100) {
                size = 'large';
                bgColor = '#ea580c';
              } else if (count >= 10) {
                size = 'medium';
                bgColor = '#475569';
              }

              const dim = size === 'large' ? 44 : size === 'medium' ? 36 : 30;
              const fontSize = size === 'large' ? 15 : size === 'medium' ? 13 : 12;

              return L.divIcon({
                html: `<div style="
                  background:${bgColor};
                  color:#fff;
                  width:${dim}px;
                  height:${dim}px;
                  border-radius:50%;
                  display:flex;
                  align-items:center;
                  justify-content:center;
                  font-weight:700;
                  font-size:${fontSize}px;
                  border:2px solid #fff;
                  box-shadow:0 2px 8px rgba(0,0,0,0.25);
                ">${count}</div>`,
                className: 'kh-cluster',
                iconSize: [dim, dim],
              });
            },
          });
      } catch {
        clusterGroup = null;
      }

      if (clusterGroup) {
        map.addLayer(clusterGroup);
        clusterRef.current = clusterGroup;
      }
      LRef.current = L;

      // Маркеры рисует ОТДЕЛЬНЫЙ эффект (см. drawnRef выше) — здесь карта
      // только объявляется готовой. Эпоха меняется при КАЖДОМ создании
      // инстанса, поэтому слои перерисовываются на новой карте, а не остаются
      // висеть на уничтоженной.
      // Восстановленный вид означает, что подгонять его под маркеры уже
      // нельзя: fitBounds отменил бы восстановление. Отмечаем подгонку
      // сделанной, чтобы эффект маркеров её не повторил.
      fitDoneRef.current = Boolean(restoredView);
      if (!cancelled) setMapEpoch((n) => n + 1);

      // Fix «пустая карта» в модалке/боттом-шите: контейнер к моменту init мог
      // иметь неустоявшийся размер (0×0, пока шит открывается) → Leaflet считал
      // размер нулевым, не грузил тайлы и не рисовал трек (скрин владельца
      // «Куда идём?» — пустой бокс). После укладки пинаем invalidateSize и
      // следим за ресайзом контейнера. Повторную подгонку вида под верный
      // размер делает эффект маркеров — там же, где и первую, чтобы «когда
      // подгонять» решалось в одном месте, а не в двух.
      const kick = () => map.invalidateSize();
      requestAnimationFrame(kick);
      setTimeout(kick, 250);
      if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
        resizeObserver = new ResizeObserver(() => map.invalidateSize());
        resizeObserver.observe(containerRef.current);
      }

      // GPS-позиция пользователя (синяя точка) — работает без интернета!
      if (showUserLocation && typeof navigator !== 'undefined' && navigator.geolocation) {
        // Маркер «Я здесь»
        const userIcon = L.divIcon({
          html: `
            <div style="position:relative;width:20px;height:20px;">
              <div style="
                position:absolute;inset:-8px;
                border-radius:50%;
                background:rgba(66,133,244,0.2);
                animation:kh-pulse 2s ease-out infinite;
              "></div>
              <div style="
                width:20px;height:20px;
                border-radius:50%;
                background:#4285f4;
                border:3px solid #fff;
                box-shadow:0 0 8px rgba(66,133,244,0.6);
              "></div>
            </div>
          `,
          className: 'kh-user-location',
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        });
        /**
         * Синей точки НЕТ, пока нет фикса.
         *
         * Раньше маркер и круг точности создавались сразу, в центре карты, с
         * радиусом 1000 м «до первого фикса». Центр карты — это середина
         * маршрута, а не человек. Если фикса не случилось (отказ в доступе,
         * помещение, нет неба), синяя точка так и оставалась там — и выглядела
         * подтверждённым положением. На экране навигации это худшее из
         * возможного: человек ведёт себя по точке, которой не существует.
         *
         * Владелец 10.08: «а где геолокация, которая определяет моё
         * положение?» — на карте было несколько синих кружков, и один из них
         * был не он, а центр маршрута.
         *
         * Теперь оба объекта рождаются в обработчике успеха, из настоящих
         * координат и настоящей точности.
         */
        let userMarker: ReturnType<typeof L.marker> | null = null;
        let accuracyCircle: ReturnType<typeof L.circle> | null = null;

        // Отслеживание позиции в реальном времени
        userLocationWatchId = navigator.geolocation.watchPosition(
          (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            const acc = pos.coords.accuracy; // метры точности (обычно 5-50м)
            setGeoDenied(false);
            const isFirstFix = !userMarker;
            if (!userMarker) {
              userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 }).addTo(map);
              accuracyCircle = L.circle([lat, lng], {
                radius: acc,
                color: '#4285f4',
                fillColor: '#4285f4',
                fillOpacity: 0.1,
                weight: 1,
                interactive: false,
              }).addTo(map);
            } else {
              userMarker.setLatLng([lat, lng]);
              accuracyCircle?.setLatLng([lat, lng]);
              accuracyCircle?.setRadius(acc);
            }
            /**
             * Центрируем карту на пользователе ТОЛЬКО на первом фиксе (владелец
             * 30.08, живой скрин: «карта с точкой скачут, невозможно
             * что-либо сделать» при GPS ±1000 м). Раньше `panTo` срабатывал
             * на КАЖДЫЙ фикс при zoom >= 12 — при плохом небе соседние фиксы
             * разбросаны в пределах точности, и карта гонялась за ними,
             * дёргая вид под рукой человека. Один раз при появлении точки —
             * законное «вот где вы» (та же причина, по которой этот маркер
             * вообще существует, см. комментарий выше); дальше камерой
             * распоряжается тот, кто её держит, а не шумный датчик.
             */
            // autoPanDoneRef живёт у вызывающего компонента и переживает
            // ремонт ЭТОГО инстанса — без него isFirstFix врал бы «первый»
            // на каждый ремонт полноэкранной карты (см. комментарий у пропа).
            if (isFirstFix && map.getZoom() >= 12 && !autoPanDoneRef?.current) {
              map.panTo([lat, lng], { animate: true, duration: 0.5 });
              if (autoPanDoneRef) autoPanDoneRef.current = true;
            }
          },
          // Отказ геолокации назывался молча — и отсутствие точки было
          // неотличимо от «точка есть, просто не видно». Говорим словами.
          () => { setGeoDenied(true); },
          {
            enableHighAccuracy: locationPriority === 'highAccuracy',
            maximumAge: 10000, // используем кэшированную позицию до 10 сек
            timeout: 15000,
          }
        );
      }
      } catch (err) {
        if (cancelled) return;
        // Синхронный сбой САМОЙ инициализации (не импорта модулей) — L.map()
        // на уже занятом контейнере, ошибка построения тайлового слоя и
        // т.п. Чаще всего это несостоявшаяся загрузка куска карты: слабая
        // связь, холодный кэш, оборванный запрос — но код стадии теперь
        // виден в логе, а не смешан с ошибками импорта.
        console.error('[LeafletMap] init failed', { code: 'map_init' }, err);
        setMapErrorCode('map_init');
        setInitFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      // Останавливаем GPS-трекинг при размонтировании (экономит батарею)
      if (userLocationWatchId !== null && typeof navigator !== 'undefined') {
        navigator.geolocation.clearWatch(userLocationWatchId);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (errorOverlay) {
        errorOverlay.remove();
        errorOverlay = null;
      }
      if (mapRef.current) {
        // Запоминаем вид ДО разрушения — следующий прогон эффекта решит,
        // восстанавливать его (ремонт из-за маркеров) или взять из пропов
        // (человек нажал «Карта» / сменил маршрут). См. viewRef выше.
        try {
          const c = mapRef.current.getCenter();
          viewRef.current = { lat: c.lat, lng: c.lng, zoom: mapRef.current.getZoom() };
        } catch (err) {
          // Карта могла не дожить до готовности (ошибка инициализации) —
          // тогда запоминать нечего, но молчать об этом нельзя: следующий
          // ремонт уедет на пропы, и это надо будет с чем-то соотнести.
          console.error('[LeafletMap] view capture failed', err);
          viewRef.current = null;
        }
        mapRef.current.remove();
        mapRef.current = null;
        clusterRef.current = null;
        LRef.current = null;
        // Слои умерли вместе с картой — ссылки на них больше ничего не значат
        // и снимать их с нового инстанса нельзя (они не его).
        drawnRef.current = [];
      }
    };
  // Зависимости — только вид и режим. `markers` здесь БОЛЬШЕ НЕТ: набор точек
  // не повод пересобирать карту (см. drawnRef выше), его рисует эффект ниже.
  // Центр разложен на числа: вызывающие часто передают литерал [a, b], и по
  // identity массива карта пересоздавалась бы на каждый рендер родителя.
  // Обработчики ушли в ref по той же причине.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1], zoom, attribution, showUserLocation, locationPriority, retry]);

  /**
   * Отрисовка маркеров НА ЖИВОЙ карте — без пересоздания инстанса.
   *
   * Снимает слои прошлого набора и рисует новый. Кластер чистится своим
   * clearLayers, отдельные линии/полигоны/маркеры — по списку drawnRef:
   * Leaflet не даёт «удалить всё, кроме тайлов», а разбирать слои по типу
   * значило бы угадывать чужое — свои мы знаем поимённо.
   */
  useEffect(() => {
    const map = mapRef.current;
    const L = LRef.current;
    if (!map || !L) return;

    const cluster = clusterRef.current as
      | { clearLayers: () => void; addLayer: (l: unknown) => void }
      | null;

    // Снять прошлый набор.
    drawnRef.current.forEach((layer) => {
      try {
        layer.remove();
      } catch (err) {
        // Слой мог быть снят вместе с картой — сказать об этом, но не падать:
        // молчаливый catch превратил бы поломку отрисовки в «маркеров нет».
        console.error('[LeafletMap] layer remove failed', err);
      }
    });
    drawnRef.current = [];
    if (cluster) cluster.clearLayers();

    const allCoords: [number, number][] = [];
    const drawn: Array<{ remove: () => void }> = [];

    markers.forEach((marker, idx) => {
      const hex = resolveColor(marker.color, 'blue');
      const markerId = marker.id ?? `mk_${idx}`;
      allCoords.push(marker.coords);

      // Геометрия маршрута (линии/полигоны) — добавляем НА карту, не в кластер
      if (marker.geometry && marker.geometry.coordinates.length >= 2) {
        const geomHex = resolveColor(marker.geometry.color ?? marker.color, 'teal');
        const coords = marker.geometry.coordinates as [number, number][];
        // Трек участвует в fitBounds — иначе линия длиннее вьюпорта обрезается
        allCoords.push(...coords);
        if (marker.geometry.type === 'polygon') {
          drawn.push(L.polygon(coords, {
            color: geomHex,
            weight: marker.geometry.weight ?? 2,
            fillOpacity: 0.15,
          }).addTo(map));
        } else {
          const dash = marker.geometry.dashArray;
          // Подложка — только у сплошных линий. У пунктирной она залила бы
          // просветы и вернула вид снятого пути, от которого пунктир и
          // отличает построение.
          if (!dash) {
            // Маршрут-линия (трек): толстая полупрозрачная подложка + тонкая яркая линия сверху — как в OsmAnd/Gaia GPS
            drawn.push(L.polyline(coords, {
              color: geomHex,
              weight: (marker.geometry.weight ?? 3) + 3,
              opacity: 0.25,
              lineCap: 'round',
              lineJoin: 'round',
            }).addTo(map));
          }
          drawn.push(L.polyline(coords, {
            color: geomHex,
            weight: marker.geometry.weight ?? 3,
            opacity: dash ? 0.75 : 0.9,
            dashArray: dash,
            lineCap: 'round',
            lineJoin: 'round',
          }).addTo(map));
        }
      }

      const svgIcon = placeMarkerSvg(hex, marker.category);
      const icon = L.divIcon({
        html: svgIcon,
        className: 'kh-marker',
        iconSize: [24, 28],
        iconAnchor: [12, 26],
        popupAnchor: [0, -26],
      });

      const m = L.marker(marker.coords, { icon });

      if (!marker.suppressBalloon) {
        m.bindPopup(buildPopupHtml(marker), { maxWidth: 260 });
      }

      // Через ref: обработчик мог смениться без перерисовки маркеров.
      m.on('click', () => onMarkerClickRef.current?.(markerId));

      if (cluster) {
        cluster.addLayer(m);
      } else {
        drawn.push(m.addTo(map));
      }
    });

    drawnRef.current = drawn;

    // Подгонка вида — РОВНО ОДИН РАЗ на инстанс карты, и только если вид не
    // восстановлен. Подгонять на каждый набор нельзя: набор меняется на
    // каждом GPS-фиксе, и карта уезжала бы из-под руки ровно так же, как
    // уезжала от пересоздания (владелец 31.08).
    if (fitDoneRef.current || allCoords.length < 2) return;
    fitDoneRef.current = true;
    const fit = () => {
      map.invalidateSize();
      map.fitBounds(allCoords as unknown as import('leaflet').LatLngBoundsExpression, {
        padding: [50, 50],
      });
    };
    fit();
    // Контейнер мог ещё не устояться в размере (боттом-шит, модалка) — тот же
    // приём, что и у invalidateSize при инициализации.
    requestAnimationFrame(fit);
    const settle = setTimeout(fit, 250);
    return () => clearTimeout(settle);
  }, [markers, mapEpoch]);

  return (
    <div style={{ height, position: 'relative' }} className={`overflow-hidden ${className}`}>
      <div ref={containerRef} style={{ height: '100%' }} />
      {showUserLocation && geoDenied && !initFailed && (
        <div
          role="status"
          style={{
            position: 'absolute', left: 12, right: 12, bottom: 12, zIndex: 1000,
            padding: '8px 12px', borderRadius: 10, textAlign: 'center',
            background: 'rgba(13,17,23,0.85)', color: '#fff',
            fontSize: 12, lineHeight: 1.35, pointerEvents: 'none',
          }}
        >
          Своё положение не определено — нет доступа к геолокации или сигнала.
          Маршрут и точки на карте настоящие.
        </div>
      )}
      {initFailed && (
        <div
          role="alert"
          style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24,
            textAlign: 'center', background: 'var(--bg-primary)',
          }}
        >
          <span style={{ color: 'var(--text-primary)', fontSize: 15, fontWeight: 600 }}>
            Карта не загрузилась
          </span>
          <span style={{ color: 'var(--text-secondary)', fontSize: 13, maxWidth: 280, lineHeight: 1.4 }}>
            Не удалось получить карту — обычно это слабая связь. Точки маршрута и
            координаты работают без неё.
          </span>
          <button
            type="button"
            onClick={() => { setInitFailed(false); setMapErrorCode(null); setRetry(n => n + 1); }}
            style={{
              marginTop: 4, padding: '9px 16px', borderRadius: 999, cursor: 'pointer',
              background: 'none', color: 'var(--ocean)', fontSize: 13, fontWeight: 600,
              border: '1px solid color-mix(in srgb, var(--ocean) 35%, transparent)',
            }}
          >
            Повторить
          </button>
          {/* Стадия отказа — не для туриста (та же фраза выше уже сказала
              достаточно), а для того, кто разбирает жалобу: leaflet_import/
              cluster_import/map_init — три разные причины под одним текстом
              «карта не загрузилась» (M0-4, владелец 28.08). */}
          {mapErrorCode && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.6 }}>
              {mapErrorCode}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
