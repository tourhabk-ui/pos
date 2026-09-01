'use client';

/**
 * components/shared/VedarMap.tsx — своя карта на MapLibre (проба 31.08).
 *
 * ── Что это и чем не является ─────────────────────────────────────────────
 *
 * Проба, а не замена Leaflet. Все девять поверхностей, где сегодня стоит
 * LeafletMap, остаются на нём: решение о миграции принимается ПО ФАКТАМ этой
 * пробы, а не заранее (требование владельца, добавка 3). Две картографические
 * библиотеки в бандле — осознанная цена пробы, и она временная.
 *
 * ── Устройство эффектов — урок того же дня ───────────────────────────────
 *
 * 31.08, за несколько часов до этого файла, чинили LeafletMap: создание карты
 * и отрисовка слоёв сидели в одном useEffect с `markers` в зависимостях, и
 * карта пересобиралась целиком на каждом GPS-фиксе («она как скакала так и
 * скачет»). Здесь разделение заложено СРАЗУ:
 *
 *   - эффект жизненного цикла — создаёт карту, зависит от темы и источника;
 *   - эффект данных — обновляет geojson-источник маршрута методом setData,
 *     то есть вообще без пересоздания слоёв;
 *   - эффект своего положения — двигает маркер, не трогая камеру.
 *
 * MapLibre к этому располагает: у него есть setData и setPaintProperty, а
 * значит поводов рвать инстанс нет ни одного.
 *
 * Автоцентрирование — ровно один раз за жизнь экрана, как и в LeafletMap
 * после правки 31.08: дальше камерой распоряжается тот, кто её держит, а не
 * шумный датчик.
 */

import { useEffect, useRef, useState } from 'react';
import type { Map as MLMap, GeoJSONSource, Marker } from 'maplibre-gl';
import {
  buildVedarStyle, vedarMapPalette, type VedarMapTheme, type VedarStyleSources,
} from '@/lib/map/vedar-style';

export interface VedarMapLine {
  /** [lng, lat] — порядок GeoJSON, не Leaflet. */
  coordinates: Array<[number, number]>;
  /** Построение (подход, связка) против снятого пути — §12. */
  connector?: boolean;
  /** Пунктир из lib/map/line-standard: набросок и импорт не сплошные. */
  dashArray?: string;
}

interface VedarMapProps {
  theme?: VedarMapTheme;
  /** Источники пакета. Отсутствие — законное состояние, см. `unavailableReason`. */
  sources?: VedarStyleSources | null;
  /** Почему карты нет — словами. Пустой тёмный экран неотличим от поломки. */
  unavailableReason?: string;
  center: [number, number];
  zoom?: number;
  lines?: VedarMapLine[];
  showUserLocation?: boolean;
  height?: string;
}

/**
 * Имя файла пакета из его адреса — без хоста и без ключей запроса.
 *
 * Адрес хранилища длинный и в строку на телефоне не влезает, а полезная
 * часть в нём одна: какой именно пакет карта не смогла прочитать.
 */
export function packFileName(url: string): string {
  const noScheme = url.replace(/^pmtiles:\/\//, '');
  const path = noScheme.split('?')[0];
  const last = path.split('/').filter(Boolean).pop();
  return last && last.length > 0 ? last : path;
}

export default function VedarMap({
  theme = 'dark',
  sources,
  unavailableReason,
  center,
  zoom = 11,
  lines = [],
  showUserLocation = false,
  height = '100%',
}: VedarMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const userMarkerRef = useRef<Marker | null>(null);
  const autoCenterDoneRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [geoDenied, setGeoDenied] = useState(false);
  /** Что именно сказала карта, когда не смогла. Видно человеку, не только в консоли. */
  const [mapError, setMapError] = useState<string | null>(null);
  /**
   * Отчёт карты о себе, когда она НЕ упала и всё-таки ничего не нарисовала.
   *
   * Полевой прогон 01.09, скрин владельца: чёрное поле между компасом и
   * карточкой расстояния. Ни рельефа, ни трека, ни строки ошибки, ни строки
   * про подложку OSM. То есть у карты было ровно два исхода — «рисую» и
   * «сказала ошибку», — а случившийся третий («смонтировалась, не упала,
   * тайлы не пришли») выглядел точно как фон страницы того же цвета.
   *
   * Это ровно тот дефект, который §4.0 запрещает: у проверки обязан быть
   * исход «не смог», и он обязан отличаться от «хорошо». Здесь он называется
   * словами и поимённо: стиль, рельеф, горизонтали — каждый сам за себя.
   */
  const [diag, setDiag] = useState<string | null>(null);

  // ── Жизненный цикл карты ────────────────────────────────────────────────
  // Зависимости — тема и адреса пакета. Ни линий, ни своего положения: они
  // обновляются на живой карте (см. эффекты ниже).
  useEffect(() => {
    if (!containerRef.current || !sources) return;
    let cancelled = false;
    /**
     * Счётчики держатся в ref, а не в state: событий `data` у карты сотни, и
     * перерисовка на каждом — это та же болезнь, что чинили в LeafletMap
     * этим же утром. Наружу они выходят один раз, по таймеру.
     */
    const seen = { terrain: 0, contours: 0 };
    let loaded = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      try {
        const maplibre = await import('maplibre-gl');
        const { Protocol } = await import('pmtiles');
        if (cancelled || !containerRef.current) return;

        // PMTiles-протокол: читатель берёт куски архива Range-запросами.
        // Регистрируется один раз на страницу — повторный вызов у MapLibre
        // просто перезапишет обработчик, но лишней работы не делаем.
        const protocol = new Protocol();
        maplibre.addProtocol('pmtiles', protocol.tile);

        const map = new maplibre.Map({
          container: containerRef.current,
          style: buildVedarStyle(theme, sources) as never,
          center: [center[1], center[0]], // [lng, lat] — порядок MapLibre
          zoom,
          attributionControl: { compact: true },
          // Жестов вращения нет намеренно: на маршруте карта — прибор, а
          // случайно повёрнутый север сбивает сверку с компасом.
          pitchWithRotate: false,
          dragRotate: false,
          touchZoomRotate: true,
        });
        map.touchZoomRotate.disableRotation();
        mapRef.current = map;

        map.on('load', () => { loaded = true; if (!cancelled) setReady(true); });

        // Пришёл ли хоть один кусок каждого источника. Не «есть ли ошибка»:
        // при чтении PMTiles через свой протокол отказ может не дойти до
        // события `error` вовсе — 01.09 карта молчала именно так.
        map.on('data', (e) => {
          const ev = e as { sourceId?: string; tile?: unknown; isSourceLoaded?: boolean };
          if (ev.sourceId === 'terrain' && ev.tile) seen.terrain += 1;
          if (ev.sourceId === 'contours' && ev.isSourceLoaded) seen.contours += 1;
        });

        /**
         * Сторож молчания. Восемь секунд — с запасом на мобильную сеть и на
         * первый Range-запрос к архиву; меньше давало бы ложную тревогу на
         * медленном канале, больше — человек в поле успевает решить, что
         * приложение сломалось.
         *
         * Молчит, когда всё хорошо: сообщение без повода читается как шум и
         * через неделю его перестают замечать.
         */
        watchdog = setTimeout(() => {
          if (cancelled) return;
          if (loaded && seen.terrain > 0) return;
          const parts: string[] = [];
          if (!loaded) parts.push('стиль не загрузился');
          if (seen.terrain === 0) parts.push('рельеф не пришёл');
          if (seen.contours === 0) parts.push('горизонтали не пришли');
          setDiag(parts.join(' · '));
        }, 8000);

        map.on('error', (e) => {
          // Молчаливый сбой карты неотличим от «приложение умерло» — тот же
          // урок, что у LeafletMap (владелец 09.08, чёрный экран).
          console.error('[VedarMap] ошибка карты', e?.error);
          // 01.09: карта рисовала чёрный прямоугольник, а причина (стиль
          // отвергнут из-за подписей без глифов) лежала в консоли телефона,
          // куда в поле не заглянешь. Ошибка обязана быть НА ЭКРАНЕ — иначе
          // разбор снова идёт перепиской.
          if (!cancelled) {
            const msg = (e?.error as Error | undefined)?.message;
            setMapError(msg ? msg.slice(0, 160) : 'неизвестная ошибка');
          }
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[VedarMap] карта не завелась', err);
        setFailed('Карта не загрузилась.');
      }
    })();

    return () => {
      cancelled = true;
      if (watchdog) clearTimeout(watchdog);
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
      setDiag(null);
    };
    // center/zoom намеренно вне зависимостей: они задают НАЧАЛЬНЫЙ вид.
    // Держи их здесь — и карта пересоздавалась бы на каждом изменении
    // центра, ровно та болезнь, что чинили в LeafletMap этим же утром.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, sources?.terrainUrl, sources?.contoursUrl]);

  // ── Линии на живой карте ────────────────────────────────────────────────
  // setData вместо пересоздания слоя: набор меняется на каждом GPS-фиксе.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('route') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: lines
        .filter(l => l.coordinates.length >= 2)
        .map(l => ({
          type: 'Feature' as const,
          properties: {
            // Свойство, а не догадка: вид линии следует из её рода (§12).
            connector: Boolean(l.connector),
            dash: l.dashArray ?? null,
          },
          geometry: { type: 'LineString' as const, coordinates: l.coordinates },
        })),
    });
  }, [lines, ready]);

  // ── Своё положение ──────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !showUserLocation) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

    let marker: Marker | null = null;
    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setGeoDenied(false);
        if (!marker) {
          const maplibre = await import('maplibre-gl');
          const el = document.createElement('div');
          el.className = 'kh-vedar-user';
          el.style.cssText =
            'width:18px;height:18px;border-radius:50%;background:#4285f4;' +
            'border:3px solid #fff;box-shadow:0 0 8px rgba(66,133,244,0.6);' +
            // Плавный проезд между фиксами вместо телепорта — та же правка,
            // что для синей точки Leaflet (владелец 31.08, GPS ±46 м).
            'transition:transform 0.6s ease-out;';
          marker = new maplibre.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
          userMarkerRef.current = marker;
          // Центрируем РОВНО ОДИН раз — «вот вы». Дальше камера человека.
          if (!autoCenterDoneRef.current) {
            autoCenterDoneRef.current = true;
            map.easeTo({ center: [lng, lat], duration: 500 });
          }
        } else {
          marker.setLngLat([lng, lat]);
        }
      },
      // Отказ геолокации называется словами: «нет фикса» и «вот вы» не
      // должны выглядеть на экране одинаково.
      () => setGeoDenied(true),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    );
    return () => {
      navigator.geolocation.clearWatch(watchId);
      marker?.remove();
      userMarkerRef.current = null;
    };
  }, [ready, showUserLocation]);

  const palette = vedarMapPalette(theme);

  // Пакета нет — говорим причину. Пустой тёмный прямоугольник читается как
  // поломка приложения, и отличить его от неё человеку нечем (§4.0).
  if (!sources || failed) {
    return (
      <div style={{ height, background: palette.background }}
        className="w-full flex items-center justify-center p-6">
        <p className="text-center text-[13px] leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}>
          {failed ?? unavailableReason ?? 'Карта района недоступна.'}
        </p>
      </div>
    );
  }

  return (
    <div style={{ height, position: 'relative', background: palette.background }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      {(mapError || diag) && (
        <div role="status"
          style={{
            position: 'absolute', left: 12, right: 12, top: 12, zIndex: 5,
            padding: '8px 12px', borderRadius: 10,
            background: 'rgba(13,17,23,0.9)', color: '#fff', fontSize: 11,
            lineHeight: 1.4,
          }}>
          Своя карта не отрисовалась: {mapError ?? diag}
          {/* Имя файла пакета — чтобы отчёт из поля называл, ЧТО не пришло,
              а не только что «не пришло». Один взгляд вместо переписки. */}
          {!mapError && diag && (
            <span style={{ display: 'block', opacity: 0.7, marginTop: 2 }}>
              искала: {packFileName(sources.terrainUrl)}
            </span>
          )}
        </div>
      )}
      {showUserLocation && geoDenied && (
        <div role="status"
          style={{
            position: 'absolute', left: 12, right: 12, bottom: 12, zIndex: 5,
            padding: '8px 12px', borderRadius: 10, textAlign: 'center',
            background: 'rgba(13,17,23,0.85)', color: '#fff', fontSize: 12,
          }}>
          Своё положение не определено
        </div>
      )}
    </div>
  );
}
