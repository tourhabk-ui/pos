/**
 * Destination-first: сначала цель, потом маршрут (UX-коррекция владельца 27.08).
 *
 * Прежний вход на /planning?mode=trail без активного маршрута был
 * приборной панелью с нулями: «Маршрут не выбран» + кнопка, открывающая
 * поиск по месту ВНУТРИ модалки. Поиск по месту (название → сгруппированные
 * пути → превью на карте → фиксация) уже существовал — только был спрятан
 * за клик. Коррекция: тот же самый инструмент показывается СРАЗУ, без
 * модалки и чёрной подложки, а «Добавить место» (полевая находка)
 * переименовано, чтобы не спорить по смыслу с «местом» как целью маршрута.
 *
 * Явно НЕ сделано в этой правке (полноценный переход к состояниям
 * destination_selected/origin_required/route_options как отдельным экранам
 * с построением маршрута от произвольной точки, «путь не найден →
 * безопасные альтернативы») — эта инфраструктура (поиск МЕСТ отдельно от
 * маршрутов, построение пути от точки) в кодовой базе не существует, и
 * симулировать её нерабочими кнопками нельзя (§4.0).
 *
 * PR 3 роадмапа владельца (27.08) добавил клик по карте: он создаёт
 * `coordinate`-цель (lib/on-route/destination.ts), но путей к ней не
 * строит. PR 4 добавил СЮДА независимый Origin («откуда начинаем?»,
 * lib/on-route/origin.ts) — построение маршрута от произвольной точки
 * (шаг 5 роадмапа) по-прежнему не существует. Честный отказ вместо
 * тишины — см. «клик по карте создаёт coordinate-цель» и «Origin
 * независим от Destination» ниже.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TRAIL = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('пустое состояние — инструмент выбора цели, не приборная панель', () => {
  it('заголовок и вызов общего пикера, без старой приборной формулировки', () => {
    // Ищем именно JSX-условие (с ведущей `{`), а не любое вхождение этой
    // фразы: она встречается ещё и в useEffect авто-загрузки рекомендаций.
    const condAt = TRAIL.indexOf('{!hasRoute && !isLoadingRoute ? (');
    const emptyState = TRAIL.slice(condAt, TRAIL.indexOf(') : (', condAt));
    expect(emptyState).toContain('Куда хотите пойти?');
    expect(emptyState).toContain('{renderDestinationPicker()}');
    expect(emptyState).not.toContain('Маршрут не выбран');
    expect(emptyState).not.toContain('openRouteModal');
  });

  it('поиск и превью — ОДНА функция, переиспользуемая модалкой и пустым состоянием', () => {
    // Не две копии одной логики выбора: только один источник JSX.
    expect(TRAIL.match(/function renderDestinationPicker/g)?.length).toBe(1);
    expect(TRAIL.match(/\{renderDestinationPicker\(\)\}/g)?.length).toBe(2);
  });

  it('рекомендации грузятся ОДНОЙ функцией — и модалкой, и авто-загрузкой', () => {
    expect(TRAIL.match(/function loadRecommendedRoutes/g)?.length).toBe(1);
    const modalFn = TRAIL.slice(TRAIL.indexOf('function openRouteModal'), TRAIL.indexOf('function openRouteModal') + 200);
    expect(modalFn).toContain('loadRecommendedRoutes()');
    expect(TRAIL).toMatch(/if \(!hasRoute && !isLoadingRoute\) loadRecommendedRoutes\(\)/);
  });

  it('поиск виден без открытой модалки: гейт — pickerVisible, не только showRouteModal', () => {
    expect(TRAIL).toContain('const pickerVisible = showRouteModal || (!hasRoute && !isLoadingRoute)');
    expect(TRAIL).toMatch(/if \(!pickerVisible \|\| q\.length < 2\)/);
  });
});

describe('сначала цель, потом путь (домен Destination, владелец 27.08)', () => {
  it('результат поиска группируется через groupRoutesByDestination, не плоским списком', () => {
    expect(TRAIL).toContain("from '@/lib/on-route/destination'");
    expect(TRAIL).toContain('groupRoutesByDestination(searchRoutes, modalQuery.trim())');
  });

  it('выбор цели фиксирует карточку места — состояние сбрасывается при новом поиске/закрытии', () => {
    expect(TRAIL).toContain('const [selectedDestination, setSelectedDestination] = useState<DestinationOption | null>(null)');
    // Смена запроса, выбор маршрута и закрытие пикера не должны оставлять
    // старую цель зафиксированной поверх нового контекста поиска.
    expect(TRAIL.match(/setSelectedDestination\(null\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('внутри зафиксированной цели путь рендерится тем же renderPathRow — не отдельной копией', () => {
    const at = TRAIL.indexOf('function renderFixedDestination');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(body).toContain('renderPathRow(routeOptionToPreview(o))');
  });
});

describe('клик по карте создаёт coordinate-цель (PR 3 роадмапа владельца, 27.08; правка 30.08 — пина с подтверждением)', () => {
  it('режим выбора точки — общая функция на цель И старт, карта не рисуется сама по себе', () => {
    expect(TRAIL).toContain("const [mapPickMode, setMapPickMode] = useState<'destination' | 'origin' | null>(null)");
    expect(TRAIL).toContain('function renderMapPickButton(');
    const at = TRAIL.indexOf('function renderMapPickButton');
    const block = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(block).toContain('const active = mapPickMode === target');
    expect(block).toContain('{active && (');
    expect(block).toContain('function confirmPick()');
    expect(block).toContain("kind: 'coordinate'");
    expect(block).toContain('routeOptions: []');
  });

  it('тап по карте роняет пину (pickedCoord), а не фиксирует цель мгновенно', () => {
    // 30.08: владелец («выбрал место, поставил точку, точка прилипла к
    // карте») — тап без подтверждения раньше сразу закрывал карту, не
    // показав, куда попал палец. Теперь тап только кладёт координату в
    // pickedCoord; коммит цели/старта — отдельная кнопка confirmPick.
    const at = TRAIL.indexOf('function renderMapPickButton');
    const block = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(block).toContain('onMapClick={(lat, lon) => setPickedCoord({ lat, lon })}');
    expect(block).not.toContain('selectRoute(');
  });

  it('подтверждение точки — явная кнопка, гасящая режим выбора', () => {
    const at = TRAIL.indexOf('function confirmPick()');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('\n    }\n', at));
    expect(body).toContain('closePicker()');
  });

  it('пина на мини-карте пикера — своим useMemo, не инлайн-массивом (identity не должна пересобираться на каждый рендер)', () => {
    expect(TRAIL).toContain('const pickMarkers: MapMarker[] = useMemo(() => (');
    expect(TRAIL).toContain('markers={pickMarkers}');
  });

  it('coordinate-цель без путей честно отказывается — не молчит и не рисует «0 путей»', () => {
    const at = TRAIL.indexOf('function renderFixedDestination');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(body).toContain('hasOptions ?');
    expect(body).toContain('Путь не найден');
  });

  it('LeafletMap.onMapClick — отдельный проп, отличный от onMarkerClick', () => {
    const MAP = readFileSync(join(ROOT, 'components/shared/LeafletMap.tsx'), 'utf-8');
    expect(MAP).toContain('onMapClick?: (lat: number, lng: number) => void');
    expect(MAP).toContain("map.on('click'");
  });
});

describe('Origin независим от Destination (PR 4 роадмапа владельца, 27.08)', () => {
  it('lib/on-route/origin.ts — тип Origin ровно из спецификации владельца', () => {
    const ORIGIN = readFileSync(join(ROOT, 'lib/on-route/origin.ts'), 'utf-8');
    expect(ORIGIN).toContain("{ kind: 'current'; lat: number; lon: number; accuracyM?: number }");
    expect(ORIGIN).toContain("{ kind: 'coordinate'; lat: number; lon: number; title?: string }");
    expect(ORIGIN).toContain("{ kind: 'place'; id: string; title: string; lat: number; lon: number }");
  });

  it('selectedOrigin — СВОЁ состояние, не поле внутри DestinationOption', () => {
    expect(TRAIL).toContain('const [selectedOrigin, setSelectedOrigin] = useState<Origin | null>(null)');
    // Не примешано в тип цели — иначе смена старта была бы сменой цели.
    // Упоминания слова «Origin» в комментариях (продолжение PR 5B-1 —
    // calculated-route считается МЕЖДУ Origin и Destination) законны;
    // проверяем именно сами объявления типов, а не текст файла целиком.
    const destSrc = readFileSync(join(ROOT, 'lib/on-route/destination.ts'), 'utf-8');
    const destTypeAt = destSrc.indexOf('export type Destination =');
    const destTypeBody = destSrc.slice(destTypeAt, destSrc.indexOf(';', destTypeAt));
    expect(destTypeBody.toLowerCase()).not.toContain('origin');
    const optAt = destSrc.indexOf('export interface DestinationOption {');
    const optBody = destSrc.slice(optAt, destSrc.indexOf('}', optAt));
    expect(optBody.toLowerCase()).not.toContain('origin');
  });

  it('изменение старта не сбрасывает зафиксированную цель', () => {
    // Единственные вызовы, которые чистят selectedOrigin, живут РЯДОМ с
    // setSelectedDestination(...) (смена/выход из цели) — обратного нет:
    // нигде в файле выбор Origin не вызывает setSelectedDestination.
    const setOriginCalls = [...TRAIL.matchAll(/setSelectedOrigin\(([^)]*)\)/g)];
    expect(setOriginCalls.length).toBeGreaterThanOrEqual(3);
    // Обработчик «Текущая позиция» и «Указать на карте» (renderOriginPicker,
    // renderMapPickButton при target==='origin') не трогают selectedDestination.
    const originPickerAt = TRAIL.indexOf('function renderOriginPicker');
    const originPickerBody = TRAIL.slice(originPickerAt, TRAIL.indexOf('\n  }\n', originPickerAt));
    expect(originPickerBody).not.toContain('setSelectedDestination(');
  });

  it('после выбора старта карточка зовёт машину состояний, а не запускает путь сама', () => {
    const at = TRAIL.indexOf('function renderFixedDestination');
    const body = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(body).toContain('{renderBuildStatus()}');
    expect(body).not.toContain('selectRoute(');
  });

  it('готовые треки у цели не выдаются за маршрут от выбранного старта', () => {
    expect(TRAIL).toContain('Готовые треки рядом с целью');
  });

  it('текущая позиция берётся из уже идущего GPS экрана, вторая подписка не заводится', () => {
    const at = TRAIL.indexOf('function renderOriginPicker');
    const body = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(body).not.toContain('getCurrentPosition');
    expect(body).not.toContain('watchPosition');
    expect(body).toContain('coords.lat');
    expect(body).toContain('coords.lng');
  });

  it('отказ геолокации назван словами, а не тихой недоступной кнопкой', () => {
    const at = TRAIL.indexOf('function renderOriginPicker');
    const body = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(body).toContain('gpsError');
    expect(body).toContain('Доступ к геопозиции запрещён');
    // Ручной выбор (карта) остаётся доступным независимо от отказа GPS.
    expect(body).toContain("renderMapPickButton('origin'");
  });
});

describe('машина состояний построения пути (PR 5A роадмапа владельца, 27.08)', () => {
  it('запускается только когда ОБЕ сущности выбраны — origin сам по себе путь не строит', () => {
    const at = TRAIL.indexOf('.build({ origin: selectedOrigin');
    expect(at).toBeGreaterThan(0);
    const effectAt = TRAIL.lastIndexOf('useEffect(', at);
    const effect = TRAIL.slice(effectAt, at);
    expect(effect).toContain('if (!selectedOrigin || !selectedDestination)');
    expect(effect).toContain("setBuildPhase({ phase: 'idle' })");
  });

  it('смена origin/destination отменяет устаревший ответ (React cleanup, не тихая гонка)', () => {
    const at = TRAIL.indexOf('.build({ origin: selectedOrigin');
    const effectAt = TRAIL.lastIndexOf('useEffect(', at);
    const effectEnd = TRAIL.indexOf('[selectedOrigin, selectedDestination, buildRetryTick]', at);
    const effect = TRAIL.slice(effectAt, effectEnd);
    expect(effect).toContain('let cancelled = false');
    expect(effect).toContain('if (!cancelled) setBuildPhase(');
    expect(effect).toContain('return () => { cancelled = true; };');
  });

  it('ни один статус ответа не запускает ориентирование напрямую', () => {
    const at = TRAIL.indexOf('function renderBuildStatus');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(body).not.toContain('selectRoute(');
    // found — единственный статус, где ЕСТЬ путь; он рендерится тем же
    // renderPathRow (открывает превью, фиксация — отдельным явным тапом),
    // не автозапуском.
    expect(body).toContain('renderPathRow(routeOptionToPreview(o))');
  });

  it('прямая линия origin→destination нигде не рисуется как маршрут', () => {
    const at = TRAIL.indexOf('function renderBuildStatus');
    const body = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(body).not.toContain('polyline');
    expect(body).not.toContain('geometry');
  });

  it('карточка использует контракт lib/on-route/route-build.ts, не свою логику', () => {
    expect(TRAIL).toContain("from '@/lib/on-route/route-build'");
    // PR 5B-1: экран ходит на сервер (httpRouteBuilder), не держит
    // локальную заглушку внутри себя — notWiredBuilder этому файлу больше
    // не нужен, он остался в самом lib/on-route/route-build.ts для тестов.
    expect(TRAIL).toContain('httpRouteBuilder');
    expect(TRAIL).not.toContain('notWiredBuilder');
  });

  it('failed с retryable даёт кнопку «Повторить», остальные статусы — нет', () => {
    const at = TRAIL.indexOf('function renderBuildStatus');
    const body = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(body).toContain("result.status === 'failed' && result.retryable");
    expect(body).toContain('Повторить');
    expect(body).toContain('setBuildRetryTick(t => t + 1)');
  });
});

describe('семантика «места» разведена: цель маршрута vs полевая находка', () => {
  it('полевое действие переименовано в «Сообщить о месте»', () => {
    expect(TRAIL).toContain("label: 'Сообщить о месте'");
    expect(TRAIL).not.toContain("label: 'Добавить место'");
  });

  it('поведение действия не изменилось — та же форма находки на /field-check', () => {
    const at = TRAIL.indexOf("id: 'place'");
    const action = TRAIL.slice(at, TRAIL.indexOf('});', at));
    expect(action).toContain("'/field-check?place=1'");
  });
});
