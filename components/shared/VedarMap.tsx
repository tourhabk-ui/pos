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
  buildVedarStyle, buildRegionOverlay, vedarMapPalette, sourceUrlIndex,
  type RegionTier, type VedarMapTheme, type VedarStyleSources,
} from '@/lib/map/vedar-style';
import { regionsIntersecting, type RegionPack } from '@/lib/map/field-base-map';
import { maplibreWorkerUrl } from '@/lib/map/maplibre-worker';
import { Minus, Plus } from 'lucide-react';
/**
 * Стили MapLibre обязательны, а не «для красоты»: именно они ставят
 * `touch-action: none` на контейнер холста. Без них браузер оставляет
 * щипок и протяжку себе (прокрутка страницы, ничего), и карта жестов не
 * видит вовсе. Скрин владельца 02.09: «масштаб не меняется» — два дня
 * своя карта была картинкой, а не картой.
 */
import 'maplibre-gl/dist/maplibre-gl.css';

export interface VedarMapLine {
  /** [lng, lat] — порядок GeoJSON, не Leaflet. */
  coordinates: Array<[number, number]>;
  /**
   * Род линии для стиля (§12): трек — сплошной; набросок и построение —
   * пунктиром; след — своя тонкая линия другого цвета. Если не задан,
   * выводится из connector/dashArray (совместимость).
   */
  kind?: 'track' | 'sketch' | 'connector' | 'trail';
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
  /**
   * Отчёт карты о себе — наружу, в дополнение к собственному оверлею.
   *
   * Полевой скрин владельца 01.09: строка на самой карте была, но её
   * накрывала непрозрачная карточка статуса, стоящая ВЫШЕ по z-index в
   * СОСЕДНЕМ стекинг-контексте (`fixed inset-0 z-0` у карты против `z-10` у
   * приборной колонки). Поднять z-index внутри самой карты это не лечит —
   * дочерний контекст не может перекрыть родителя соседа, только его
   * содержимое (`§12`-подобный урок, только про CSS, а не про линии).
   * Экран, знающий причину и не показывающий её, снова не отличим от
   * поломки — молчание на своём месте, а видимость на чужом.
   */
  onDiagnostic?: (message: string | null) => void;
  /**
   * Пакеты соседних районов (02.09, скрин владельца «карты нет других
   * районов»). Основной стиль описывает один район; эти подкладываются на
   * живую карту, когда попадают в видимую область. `baseRegion` — район
   * основного стиля, его второй раз не подкладываем.
   */
  packs?: readonly RegionPack[];
  baseRegion?: string;
  /**
   * Свои кнопки «+»/«−» на карте. Выключаются, когда их рисует экран
   * снаружи (приборный ряд «На маршруте»): на середине высоты карты их
   * накрывал нижний лист — скрин владельца 02.09 08:18.
   */
  showZoomButtons?: boolean;
  /** Ручка управления наружу — для кнопок масштаба вне карты. null при размонтировании. */
  onControls?: (handle: VedarMapHandle | null) => void;
}

export interface VedarMapHandle {
  zoomIn(): void;
  zoomOut(): void;
}

/**
 * Ярус `detail` (горизонтали, OSM-заливки и линии) подкладывается соседям
 * только с этого зума: ниже contour-minor всё равно не рисуется (minzoom 11),
 * а обзорному виду хватает рельефа и вершин — платить мегабайты GeoJSON за
 * него не за что. Основной район это не касается: его стиль грузит всё
 * сразу, как и прежде.
 */
export const DETAIL_MIN_ZOOM = 10;

/**
 * Кнопки масштаба — одна реализация на карту и на приборный ряд снаружи.
 * В перчатке и на морозе щипок не всегда выходит, а «+»/«−» есть у любого
 * навигатора. Действие — непрозрачное (§2).
 */
export function VedarZoomButtons({ handle }: { handle: VedarMapHandle | null }) {
  if (!handle) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {([['Приблизить', 1, Plus], ['Отдалить', -1, Minus]] as const).map(([label, dir, Icon]) => (
        <button key={label} type="button" aria-label={label}
          onClick={() => { if (dir > 0) handle.zoomIn(); else handle.zoomOut(); }}
          style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'var(--bg-card)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', display: 'grid', placeItems: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          }}>
          <Icon className="w-5 h-5" />
        </button>
      ))}
    </div>
  );
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

/**
 * Строка об отказе карты — целиком, вместе с тем, ЧТО именно отказало.
 *
 * Скрин владельца 02.09 из поля: «Своя карта не отрисовалась: Expected ','
 * or ']' after array element in JSON at position 387966». Обе половины
 * сообщения были неверны по сути:
 *
 *   - «карта не отрисовалась» — карта в тот момент рисовала: рельеф,
 *     горизонтали, свой след. Не пришёл ОДИН слой из восьмидесяти;
 *   - текст исключения без имени файла не даёт даже направления: у десяти
 *     районов по восемь GeoJSON, и который оборвался — неизвестно.
 *
 * Отсюда три разных исхода вместо одного (§4.0): «карта не поднялась»,
 * «слой не пришёл» и «не смог назвать источник» — у каждого свои слова.
 * Плюс отдельная пометка о повторе: «качаем заново» — это не тот же исход,
 * что «не пришло и не придёт», и ждать человек в этих случаях будет разное.
 */
export function mapErrorText(input: {
  message?: string;
  sourceId?: string;
  file?: string;
  mapLoaded: boolean;
  retrying?: boolean;
}): string {
  const detail = input.message ? input.message.slice(0, 160) : 'неизвестная ошибка';
  // Имя источника — запасной ответ, когда адрес файла не нашёлся: он всё
  // равно называет слой («osm-paths»), а «не знаю» здесь было бы шагом
  // назад к безымянной строке из поля.
  const where = input.file ? packFileName(input.file) : input.sourceId;
  const tail = input.retrying ? ' — качаем заново' : '';
  if (input.mapLoaded && where) return `Слой карты не пришёл — ${where}: ${detail}${tail}`;
  if (where) return `Своя карта не отрисовалась — ${where}: ${detail}${tail}`;
  return `Своя карта не отрисовалась: ${detail}${tail}`;
}

/**
 * Прямой запрос к файлу пакета — тем же способом, что читатель PMTiles:
 * Range-GET через CORS. Ответ — словами для экрана: HTTP-код и время либо
 * имя исключения.
 *
 * Исключение здесь и есть диагноз. Отказ preflight (заголовок Range не в
 * safelist — браузер сперва шлёт OPTIONS), отсутствие CORS и обрыв сети
 * браузер отдаёт одним `TypeError: Failed to fetch`; 403/404 бакета —
 * кодом. Эти два класса лечатся в разных местах: первый — в настройках
 * CORS хранилища, второй — в самом файле. Снаружи, с раннера, их не
 * различить: у него другая сеть и другой клиент.
 */
export async function probeFetch(
  url: string,
  range: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  try {
    const res = await fetchImpl(url, { headers: { range }, cache: 'no-store', mode: 'cors' });
    return `HTTP ${res.status} за ${secs()} с`;
  } catch (err) {
    const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return `${name.slice(0, 80)} через ${secs()} с`;
  }
}

/**
 * Жив ли воркер из blob: — ровно тот способ, которым MapLibre поднимает свой.
 *
 * Утро 02.09 (Камчатка): телефон достаёт оба файла пакета за 0.2 с, а стиль,
 * рельеф и горизонтали молчат разом. Общее у трёх — воркер: геоджсон
 * режется в нём, тайлы рельефа декодируются в нём, и без него `load` не
 * наступает никогда, а `error` не звучит. Проверка не через MapLibre, а
 * напрямую: крошечный воркер обязан ответить за секунды. Исход называется
 * словами — «отвечает», «молчит», «упал», «не создался» — четыре разные
 * беды с четырьмя разными лекарствами.
 */
export function probeWorker(
  timeoutMs = 2000,
  makeWorker: () => Worker = () =>
    new Worker(URL.createObjectURL(new Blob(['postMessage("ok")'], { type: 'text/javascript' }))),
): Promise<string> {
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  return new Promise((resolve) => {
    let w: Worker | null = null;
    let settled = false;
    const done = (s: string) => {
      if (settled) return;
      settled = true;
      w?.terminate();
      resolve(s);
    };
    const timer = setTimeout(() => done(`воркер молчит ${secs()} с`), timeoutMs);
    try {
      w = makeWorker();
      w.onmessage = () => { clearTimeout(timer); done(`воркер отвечает за ${secs()} с`); };
      w.onerror = (e) => {
        clearTimeout(timer);
        const msg = (e as { message?: string }).message;
        done(`воркер упал: ${(msg || 'без текста').slice(0, 80)}`);
      };
    } catch (err) {
      clearTimeout(timer);
      const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      done(`воркер не создался: ${name.slice(0, 80)}`);
    }
  });
}

/**
 * WebGL2 на этом устройстве. MapLibre с пятой версии без него не рисует
 * вовсе, а отказ контекста наружу может не дойти: карта создаётся, слои
 * молчат. Имя рендерера — чтобы отличить «блокирован драйвер» от
 * «программный fallback», это разные разговоры с владельцем телефона.
 */
export function webglReport(
  makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
): string {
  try {
    const gl = makeCanvas().getContext('webgl2');
    if (!gl) return 'WebGL2 недоступен';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    return `WebGL2 есть (${renderer.slice(0, 60)})`;
  } catch (err) {
    const name = err instanceof Error ? err.name : String(err);
    return `WebGL2: исключение ${name}`.slice(0, 80);
  }
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
  onDiagnostic,
  packs = [],
  baseRegion,
  showZoomButtons = true,
  onControls,
}: VedarMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const userMarkerRef = useRef<Marker | null>(null);
  const autoCenterDoneRef = useRef(false);
  // Ref, не проп напрямую в зависимостях: инлайновая стрелка у вызывающего
  // меняет identity на каждый рендер — тот же приём, что onMapClickRef у
  // LeafletMap, чтобы не дёргать жизненный цикл карты чужой identity.
  const onDiagnosticRef = useRef(onDiagnostic);
  onDiagnosticRef.current = onDiagnostic;
  const onControlsRef = useRef(onControls);
  useEffect(() => { onControlsRef.current = onControls; }, [onControls]);
  /**
   * Идентификатор источника MapLibre -> адрес его файла. Заполняется из
   * самого стиля и из подложенных соседей (см. sourceUrlIndex): отказ
   * источника обязан называть ФАЙЛ, а не только текст исключения.
   */
  const fileBySourceRef = useRef<Record<string, string>>({});
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
    const seen = { terrain: 0, contours: 0, terrainRequested: 0, styledata: 0 };
    let loaded = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    /**
     * Нарушения CSP — от самого браузера, поимённо. Вечер 01.09 стиль
     * молчал из-за запрета воркера из blob:, и узнали это по коду
     * next.config.js, а не по телефону: браузер ЗНАЛ, какую директиву и
     * какой адрес он заблокировал, и никто его не спрашивал.
     */
    const cspHits: string[] = [];
    const onCsp = (e: Event) => {
      const v = e as { violatedDirective?: string; blockedURI?: string };
      if (cspHits.length < 3) {
        cspHits.push(`${v.violatedDirective ?? '?'} → ${(v.blockedURI || '?').slice(0, 60)}`);
      }
    };
    document.addEventListener('securitypolicyviolation', onCsp);

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

        // Воркер — свой, с нашего домена и абсолютным адресом. Без этого
        // MapLibre под webpack получает пустой адрес и поднимает мёртвый
        // воркер: два дня полевых прогонов 01-02.09 карта молчала именно
        // так. Разбор — lib/map/maplibre-worker.ts.
        maplibre.setWorkerUrl(maplibreWorkerUrl(window.location.origin));

        const style = buildVedarStyle(theme, sources);
        // Индекс «источник -> файл» строится ДО карты и из того же объекта
        // стиля, которым карта создаётся: иначе он рассказывал бы о другом
        // наборе источников, чем тот, что реально просят с сети.
        fileBySourceRef.current = sourceUrlIndex(style.sources as Record<string, unknown>);

        const map = new maplibre.Map({
          container: containerRef.current,
          style: style as never,
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
        let diagShown = false;
        map.on('data', (e) => {
          const ev = e as { sourceId?: string; tile?: unknown; isSourceLoaded?: boolean };
          if (ev.sourceId === 'terrain' && ev.tile) {
            seen.terrain += 1;
            // Поздний приход — не отказ. На слабом канале в горах пакет
            // может ехать дольше сторожа; сообщение, пережившее рельеф,
            // врало бы про карту, которая уже рисует.
            if (diagShown) { diagShown = false; setDiag(null); }
          }
          if (ev.sourceId === 'contours' && ev.isSourceLoaded) seen.contours += 1;
        });

        /**
         * Источник, оборвавшийся на полпути, — и повтор ровно один раз.
         *
         * Перепись хранилища 02.09 с раннера: все 90 файлов пакетов целы,
         * 118 МБ скачаны и разобраны за 26 секунд. Значит GeoJSON рвался НЕ
         * в бакете, а по дороге на телефон: мобильный канал обрывает тело, и
         * MapLibre получает половину массива — отсюда «Expected ',' or ']'»
         * на позиции, равной длине пришедшего текста.
         *
         * Своего повтора у geojson-источника нет: один отказ — и слой мёртв
         * до пересоздания карты. `setData(url)` заказывает файл заново.
         * Повтор строго ОДИН на источник за жизнь карты: на глухом канале
         * бесконечные попытки съедали бы батарею и трафик там, где их
         * меньше всего можно тратить.
         */
        const retriedSources = new Set<string>();
        let awaitingRetry: string | null = null;
        map.on('sourcedata', (e) => {
          const ev = e as { sourceId?: string; isSourceLoaded?: boolean };
          // Слой, о котором мы сказали «не пришёл», всё-таки пришёл —
          // сообщение снимается: жалоба на живой слой хуже молчания.
          if (awaitingRetry && ev.sourceId === awaitingRetry && ev.isSourceLoaded) {
            awaitingRetry = null;
            if (!cancelled) setMapError(null);
          }
        });
        // Запрошено — отдельно от пришло. Ноль запросов значит, что источник
        // не получил TileJSON (протокол PMTiles не ответил); запросы есть, а
        // пришедших нет — тайлы не декодируются (воркер). Две разные беды.
        map.on('dataloading', (e) => {
          const ev = e as { sourceId?: string; tile?: unknown };
          if (ev.sourceId === 'terrain' && ev.tile) seen.terrainRequested += 1;
        });
        map.on('styledata', () => { seen.styledata += 1; });

        /**
         * Сторож молчания. Восемь секунд — с запасом на мобильную сеть и на
         * первый Range-запрос к архиву; меньше давало бы ложную тревогу на
         * медленном канале, больше — человек в поле успевает решить, что
         * приложение сломалось.
         *
         * Молчит, когда всё хорошо: сообщение без повода читается как шум и
         * через неделю его перестают замечать.
         *
         * Второй этап — самопроверка. Полевой прогон 01.09 (вечер): сторож
         * назвал «стиль не загрузился · рельеф не пришёл · горизонтали не
         * пришли», но ПОЧЕМУ — знал только браузер телефона: CORS, preflight
         * на заголовок Range, 403 бакета, обрыв сети снаружи неотличимы, а
         * раннер GitHub ходит из другой сети и другим клиентом. Поэтому карта
         * сама спрашивает оба файла тем же способом, что читатель PMTiles
         * (Range + CORS), и печатает ответ: HTTP-код или имя исключения.
         */
        watchdog = setTimeout(async () => {
          if (cancelled) return;
          if (loaded && seen.terrain > 0) return;
          const parts: string[] = [];
          if (!loaded) parts.push('стиль не загрузился');
          if (seen.terrain === 0) parts.push('рельеф не пришёл');
          if (seen.contours === 0) parts.push('горизонтали не пришли');
          // Приговор целиком собирается здесь, а не у того, кто его рисует:
          // строку показывают ДВА места (сама карта и приборная колонка), и
          // разъехавшиеся формулировки — та же беда, что три реализации
          // одного правила линий (§12).
          const head = `Своя карта не отрисовалась: ${parts.join(' · ')}`;
          diagShown = true;
          setDiag(head);

          const rawTerrain = sources.terrainUrl.replace(/^pmtiles:\/\//, '');
          const [t, c, w] = await Promise.all([
            // Тот же первый запрос, что делает читатель: заголовок архива.
            probeFetch(rawTerrain, 'bytes=0-16383'),
            probeFetch(sources.contoursUrl, 'bytes=0-1023'),
            probeWorker(),
          ]);
          if (cancelled || !diagShown) return;
          // Третий этап (утро 02.09): сеть отвечала 206 за 0.2 с, а карта
          // молчала — значит беда не снаружи. Печатается то, что знает только
          // этот браузер: жив ли воркер, есть ли WebGL2, что запретил CSP,
          // дошёл ли стиль и сколько тайлов запрошено против пришедших.
          const state = [
            `стиль: ${map.isStyleLoaded() ? 'загружен' : 'нет'}${seen.styledata ? '' : ', styledata не было'}`,
            // Адрес, который MapLibre считает своим воркером. Пустой или
            // file:// — тот самый дефект сборки (lib/map/maplibre-worker.ts).
            `воркер MapLibre: ${maplibre.getWorkerUrl() || 'адрес пуст'}`,
            `тайлов рельефа запрошено ${seen.terrainRequested}, пришло ${seen.terrain}`,
            w,
            webglReport(),
            cspHits.length ? `CSP: ${cspHits.join('; ')}` : 'CSP: нарушений нет',
          ].join(' · ');
          setDiag(`${head} — ${packFileName(rawTerrain)}: ${t}; ${packFileName(sources.contoursUrl)}: ${c} · ${state}`);
        }, 8000);

        map.on('error', (e) => {
          // Молчаливый сбой карты неотличим от «приложение умерло» — тот же
          // урок, что у LeafletMap (владелец 09.08, чёрный экран).
          console.error('[VedarMap] ошибка карты', e?.error);
          // 01.09: карта рисовала чёрный прямоугольник, а причина (стиль
          // отвергнут из-за подписей без глифов) лежала в консоли телефона,
          // куда в поле не заглянешь. Ошибка обязана быть НА ЭКРАНЕ — иначе
          // разбор снова идёт перепиской.
          if (cancelled) return;
          const msg = (e?.error as Error | undefined)?.message;
          const sourceId = (e as { sourceId?: string } | undefined)?.sourceId;
          const file = sourceId ? fileBySourceRef.current[sourceId] : undefined;

          // Первый обрыв — заказываем файл заново и говорим об этом. Молча
          // повторять нельзя: человек в поле должен понимать, почему часть
          // карты пуста прямо сейчас.
          let retrying = false;
          // Весь повтор — под try целиком, а не только setData. Этот
          // обработчик стоит на экране, по которому идут в поле: исключение
          // отсюда улетело бы внутрь MapLibre (fire), и строка об ошибке,
          // ради которой всё это писалось, до человека бы не дошла. Отказ
          // самой диагностики не должен стоить диагностики.
          try {
            if (sourceId && file && !retriedSources.has(sourceId)) {
              const src = map.getSource(sourceId) as GeoJSONSource | undefined;
              if (src && typeof src.setData === 'function') {
                retriedSources.add(sourceId);
                awaitingRetry = sourceId;
                retrying = true;
                src.setData(file);
              }
            }
          } catch (err) {
            retrying = false;
            awaitingRetry = null;
            console.error('[VedarMap] повтор источника не удался', sourceId, err);
          }

          setMapError(mapErrorText({
            message: msg,
            sourceId,
            file,
            // Карта уже поднялась — значит упал ОДИН слой, а не карта.
            // Скрин 02.09 говорил «карта не отрисовалась» ровно тогда,
            // когда рельеф был на месте: это разные беды и разные слова.
            mapLoaded: loaded,
            retrying,
          }));
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
      document.removeEventListener('securitypolicyviolation', onCsp);
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

  // ── Ручка управления наружу ─────────────────────────────────────────────
  // Живёт от `load` до размонтирования; кнопки снаружи без неё не рисуются.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) { onControlsRef.current?.(null); return; }
    onControlsRef.current?.({ zoomIn: () => map.zoomIn(), zoomOut: () => map.zoomOut() });
    return () => onControlsRef.current?.(null);
  }, [ready]);

  // ── Соседние районы — по видимой области ────────────────────────────────
  // Скрин владельца 02.09 08:21: при отдалении виден один пакет, остальные
  // девять — чёрное поле. Стиль описывает район точки; соседей карта
  // подкладывает сама, когда их bbox входит в видимую область, ярусами
  // (см. buildRegionOverlay): рельеф и вершины — сразу, горизонтали и OSM —
  // с DETAIL_MIN_ZOOM. Добавленное не снимается: MapLibre держит источники
  // без запросов, пока их тайлы не в кадре, а GeoJSON уже скачан.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || packs.length === 0) return;
    const added = new Set<string>();
    const ensure = () => {
      const b = map.getBounds();
      const view = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
      const zoom = map.getZoom();
      for (const region of regionsIntersecting(packs, view)) {
        if (region === baseRegion) continue;
        const pack = packs.find(p => p.region === region);
        if (!pack) continue;
        const tiers: RegionTier[] = zoom >= DETAIL_MIN_ZOOM ? ['base', 'detail'] : ['base'];
        for (const tier of tiers) {
          const key = `${region}:${tier}`;
          if (added.has(key)) continue;
          added.add(key);
          const overlay = buildRegionOverlay(theme, {
            terrainUrl: pack.source.terrainUrl,
            contoursUrl: pack.source.contoursUrl,
            terrainMaxZoom: pack.source.terrainMaxZoom,
            attribution: '© Copernicus DEM (ESA)',
            glyphsUrl: pack.source.glyphsUrl,
            glyphsFont: pack.source.glyphsFont,
            osmUrls: pack.source.osmUrls,
            vectorUrl: pack.source.vectorUrl,
          }, region, tier);
          try {
            // Соседи попадают в индекс имён вместе со своими источниками:
            // именно их файлы (восемь на район) чаще всего и не приходят, а
            // безымянный отказ соседа неотличим от отказа своего района.
            Object.assign(fileBySourceRef.current, sourceUrlIndex(overlay.sources));
            for (const [id, src] of Object.entries(overlay.sources)) {
              if (!map.getSource(id)) map.addSource(id, src as never);
            }
            for (const layer of overlay.layers) {
              const id = String(layer.id);
              if (map.getLayer(id)) continue;
              // Всё под линией маршрута: путь читается поверх карты. Заливки
              // соседа — под его же тенью, иначе лес лёг бы поверх рельефа.
              const hill = `hillshade-${region}`;
              const before = layer.type === 'fill' && map.getLayer(hill) ? hill : 'route-trail';
              map.addLayer(layer as never, map.getLayer(before) ? before : undefined);
            }
          } catch (err) {
            // Не молчим: район, который не подложился, — это «не смог», а не
            // «соседей нет» (§4.0). Карта основного района при этом цела.
            console.error(`[VedarMap] район ${region} (${tier}) не подложился`, err);
          }
        }
      }
    };
    ensure();
    map.on('moveend', ensure);
    return () => { map.off('moveend', ensure); };
  }, [ready, packs, baseRegion, theme]);

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
            // Род линии — свойством, стиль его читает слоями (§12). Пунктир
            // от line-standard означает «не снятый трек»: набросок или импорт.
            // Первый живой рендер 02.09: без этого набросок подборки лёг
            // веером толстых сплошных зелёных линий.
            kind: l.kind ?? (l.connector ? 'connector' : l.dashArray ? 'sketch' : 'track'),
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

  // Сообщение наружу — вызывающий решает, где ему видно (см. onDiagnostic).
  // Один эффект на оба источника: `failed` сюда не входит — тот случай уже
  // рисует свой полноэкранный текст вместо карты, дублировать некуда.
  useEffect(() => {
    onDiagnosticRef.current?.(mapError ?? diag ?? null);
  }, [mapError, diag]);
  // Очистка — отдельным эффектом с []: срабатывает только на размонтирование
  // компонента, а не на каждую смену диагноза (в отличие от возврата из
  // эффекта выше, который выполнялся бы на каждой смене mapError/diag).
  useEffect(() => () => onDiagnosticRef.current?.(null), []);

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
      <div ref={containerRef} style={{ height: '100%', width: '100%', touchAction: 'none' }} />
      {/* Масштаб кнопками — в дополнение к щипку, не вместо него. Свои
          кнопки карта рисует, только когда снаружи их никто не рисует
          (showZoomButtons): 02.09 на середине высоты их накрыл нижний лист
          приборов, и экран «На маршруте» теперь ставит их сам, в приборный
          ряд рядом с компасом, где ничто не накрывает. Слева сверху, а не на
          середине: угадывать высоту листа пикселями — та же fixed-угадайка,
          что уже ловили с компасом (29.08). */}
      {ready && showZoomButtons && (
        <div style={{ position: 'absolute', left: 12, top: 12, zIndex: 5 }}>
          <VedarZoomButtons handle={{
            zoomIn: () => { const m = mapRef.current; if (m) m.zoomIn(); },
            zoomOut: () => { const m = mapRef.current; if (m) m.zoomOut(); },
          }} />
        </div>
      )}
      {(mapError || diag) && (
        <div role="status"
          style={{
            position: 'absolute', left: 12, right: 12, top: 12, zIndex: 5,
            padding: '8px 12px', borderRadius: 10,
            background: 'rgba(13,17,23,0.9)', color: '#fff', fontSize: 11,
            lineHeight: 1.4,
          }}>
          {mapError ?? diag}
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
