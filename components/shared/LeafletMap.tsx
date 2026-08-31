'use client';

import { useEffect, useRef, useState } from 'react';
import type { Map as LMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

export { MarkerType } from '@/components/shared/leaflet-types';
export type { MapMarkerGeometry, MapMarker } from '@/components/shared/leaflet-types';
import type { MapMarker, MapMarkerGeometry } from '@/components/shared/leaflet-types';

interface LeafletMapProps {
  markers?: MapMarker[];
  center?: [number, number];
  zoom?: number;
  height?: string;
  className?: string;
  attribution?: boolean;
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
        attributionControl: attribution !== false,
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

      if (onMapClick) {
        map.on('click', (e) => onMapClick(e.latlng.lat, e.latlng.lng));
      }

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

      const allCoords: [number, number][] = [];

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
            L.polygon(coords, {
              color: geomHex,
              weight: marker.geometry.weight ?? 2,
              fillOpacity: 0.15,
            }).addTo(map);
          } else {
            const dash = marker.geometry.dashArray;
            // Подложка — только у сплошных линий. У пунктирной она залила бы
            // просветы и вернула вид снятого пути, от которого пунктир и
            // отличает построение.
            if (!dash) {
              // Маршрут-линия (трек): толстая полупрозрачная подложка + тонкая яркая линия сверху — как в OsmAnd/Gaia GPS
              L.polyline(coords, {
                color: geomHex,
                weight: (marker.geometry.weight ?? 3) + 3,
                opacity: 0.25,
                lineCap: 'round',
                lineJoin: 'round',
              }).addTo(map);
            }
            L.polyline(coords, {
              color: geomHex,
              weight: marker.geometry.weight ?? 3,
              opacity: dash ? 0.75 : 0.9,
              dashArray: dash,
              lineCap: 'round',
              lineJoin: 'round',
            }).addTo(map);
          }
        }

        // Кастомный SVG-маркер по типу локации
        const svgIcons: Record<string, string> = {
          volcano:    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 2L2 22h20L12 2z" fill="${hex}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="14" r="2" fill="#fff" opacity="0.8"/></svg>`,
          hot_spring: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M9 14c0-2 1.5-3 3-3s3 1 3 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
          geyser:     `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M12 8v6M9 11l3 3 3-3" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
          lake:       `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M7 14c1.5-1 3-1 5 0s3.5 1 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
          mountain:   `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 4L3 22h18L12 4z" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M8 22l4-8 4 8" stroke="#fff" stroke-width="1" stroke-linecap="round"/></svg>`,
          waterfall:  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M10 10v8M14 10v8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
          beach:      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="14" r="3" fill="#fff" opacity="0.6"/></svg>`,
          viewpoint:  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M12 10v4l3 2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
          rock:       `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M7 20l2-12 6-4 4 8-3 8H7z" fill="${hex}" stroke="#fff" stroke-width="1.5"/></svg>`,
          island:     `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><ellipse cx="12" cy="18" rx="8" ry="4" fill="#475569" opacity="0.3"/><path d="M4 18c0-4 3-8 8-8s8 4 8 8-3.5 6-8 6-8-2-8-6z" fill="${hex}" stroke="#fff" stroke-width="1.5"/></svg>`,
          forest:     `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 4L6 16h12L12 4z" fill="${hex}" stroke="#fff" stroke-width="1.5"/><rect x="11" y="16" width="2" height="6" rx="1" fill="#fff" opacity="0.6"/></svg>`,
          river:      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M8 14c2 0 2-3 4-3s2 3 4 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
          bay:        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M7 14c1.5-1.5 3-1.5 5 0s3.5 1.5 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><path d="M7 18c1.5-1 3-1 5 0s3.5 1 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/></svg>`,
          museum:     `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M3 14l9-8 9 8v6H3v-6z" fill="${hex}" stroke="#fff" stroke-width="1.5"/><rect x="7" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/><rect x="11" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/><rect x="15" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/></svg>`,
          historical: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M12 8v4l2 2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
          other:      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="14" r="3" fill="#fff" opacity="0.5"/></svg>`,
        };

        const svgIcon = svgIcons[marker.category ?? 'other'] ?? svgIcons.other;
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

        if (onMarkerClick) {
          m.on('click', () => onMarkerClick(markerId));
        }

        if (clusterGroup) {
          clusterGroup.addLayer(m);
        } else {
          m.addTo(map);
        }
      });

      if (clusterGroup) {
        map.addLayer(clusterGroup);
        clusterRef.current = clusterGroup;
      }

      // Подгоняем вид под все маркеры (через кластер).
      // При непрошеном ремонте (restoredView) НЕ подгоняем: вид уже
      // восстановлен тем, каким его оставил человек, а fitBounds сбросил бы
      // его обратно — ровно тот скачок, ради которого заведён viewRef.
      const fitAll = () => {
        if (restoredView) return;
        if (allCoords.length > 1) {
          map.fitBounds(allCoords as unknown as import('leaflet').LatLngBoundsExpression, {
            padding: [50, 50],
          });
        }
      };
      fitAll();

      // Fix «пустая карта» в модалке/боттом-шите: контейнер к моменту init мог
      // иметь неустоявшийся размер (0×0, пока шит открывается) → Leaflet считал
      // размер нулевым, не грузил тайлы и не рисовал трек (скрин владельца
      // «Куда идём?» — пустой бокс). После укладки пинаем invalidateSize (+
      // повторный fitBounds под верный размер) и следим за ресайзом контейнера.
      const kick = () => { map.invalidateSize(); fitAll(); };
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
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, center, zoom, onMarkerClick, onMapClick, attribution, showUserLocation, locationPriority, retry]);

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
