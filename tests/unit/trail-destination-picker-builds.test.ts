/**
 * Владелец 07.09, полевой скрин: «наверху конечная точка не меняется» и
 * «при выборе по кнопки сменить маршрут маршрут не строится, а по выбору
 * точки на карте строится».
 *
 * Обе жалобы — следствие одного и того же места. Построение пути ждёт ОБА
 * независимых состояния разом (selectedOrigin И selectedDestination,
 * useEffect у httpRouteBuilder.build). «Проложить сюда» с карточки точки
 * (routeFromCard) ставит их атомарно одним вызовом — путь строится сам.
 * «Сменить маршрут» → выбор цели (confirmPick, клик по «Места») чистил
 * selectedOrigin ПОЛНОСТЬЮ в null при каждом выборе цели: эффект построения
 * не запускался вовсе, пока человек не находил и не нажимал ОТДЕЛЬНУЮ,
 * ничем не подсказанную кнопку «Текущая позиция» — с виду «маршрут не
 * строится».
 *
 * Вторая жалоба — про шапку (FieldStatusStrip.routeTitle): activeRouteTitle
 * называет ЛИНИЮ track/waypoints каталожного маршрута (её так же подписывает
 * computeRouteLineMarker) и не имеет отношения к отдельно рассчитанному
 * автопути (calculatedPreview) с «Проложить сюда»/«Сменить маршрут» —
 * поэтому шапка застревала на старом каталожном названии, пока на карте уже
 * лежал совсем другой, только что построенный путь.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TRAIL = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('старт по умолчанию — живой фикс, не null (07.09: "маршрут не строится" через кнопку)', () => {
  it('currentOriginOrNull — общий кусок между routeFromCard и «Сменить маршрут»', () => {
    expect(TRAIL).toContain('const currentOriginOrNull = useCallback((): Origin | null => (');
    expect(TRAIL).toContain("coords ? { kind: 'current', lat: coords.lat, lon: coords.lng, accuracyM: coords.accuracy ?? undefined } : null");
  });

  it('confirmPick (клик по карте → координата-цель) больше не чистит origin в null безусловно', () => {
    const at = TRAIL.indexOf('function confirmPick()');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('\n    }\n', at));
    expect(body).toContain('setSelectedOrigin(currentOriginOrNull())');
    expect(body).not.toContain('setSelectedOrigin(null)');
  });

  it('клик по найденному месту («Места» в «Сменить маршрут») — тот же дефолт старта', () => {
    expect(TRAIL).toContain('onClick={() => { setSelectedDestination(d); setSelectedOrigin(currentOriginOrNull()); }}');
    expect(TRAIL).not.toContain('setSelectedDestination(d); setSelectedOrigin(null);');
  });

  it('routeFromCard («Проложить сюда» с карточки точки) не тронут — ставит origin и destination одним вызовом', () => {
    expect(TRAIL).toMatch(/setSelectedOrigin\(\{ kind: 'current', lat: coords\.lat, lon: coords\.lng, accuracyM: coords\.accuracy \?\? undefined \}\);\s*\n\s*setSelectedDestination\(\{ destination: \{ kind: 'coordinate', lat: pointCard\.lat, lon: pointCard\.lng/);
  });
});

describe('шапка называет то, что реально на карте (07.09: "конечная точка не меняется")', () => {
  it('FieldStatusStrip.routeTitle — calculatedPreview поверх activeRouteTitle, когда автопуть построен', () => {
    expect(TRAIL).toContain('routeTitle={calculatedPreview ? calculatedPreview.title : activeRouteTitle}');
  });

  it('activeRouteTitle сам НЕ трогается расчётным автопутём — он остаётся титулом линии track/waypoints', () => {
    // computeRouteLineMarker подписывает ИМЕННО эту линию activeRouteTitle —
    // если бы routeFromCard/confirmPick переписывали его значением
    // calculatedPreview, полотно каталожного маршрута на карте осталось бы
    // под чужим именем (та ошибка, которую чинит §12 для вида линий).
    expect(TRAIL).not.toMatch(/setActiveRouteTitle\(r\.title\)/);
    expect(TRAIL).toContain("title: activeRouteTitle ?? 'Маршрут',");
  });

  it('selectRoute (выбор нового каталожного маршрута) сбрасывает старый calculatedPreview', () => {
    const at = TRAIL.indexOf('function selectRoute(r: { id: string }) {');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('\n  }\n', at));
    expect(body).toContain('setCalculatedPreview(null)');
  });
});

/**
 * Владелец 07.09, «Мишенная сопка»: «шикарно рисуется маршрут, но не
 * меняется название и не пересчитываются км из старой формы — видно, что
 * это разные механизмы». Три отдельных находки:
 *
 *  1. Тап по МЕСТУ платформы на /planning шёл мимо onPlaceClick (проп не был
 *     передан вовсе) и падал на голый onMapClick внутри VedarMap — цель
 *     «Проложить сюда» строилась под именем «Точка на карте», даже когда
 *     тапнули по подписанному месту.
 *  2. Компас («на точку», азимут) и главная цифра/ETA внизу листа остаются
 *     инструментами КАТАЛОЖНОГО маршрута (nextWp/waypoints) и не знают о
 *     calculatedPreview вовсе — построенный автопуть рисуется на карте, а
 *     приборы продолжают показывать старую цель.
 *  3. «Всего X км» не было нигде — только «до следующей точки».
 */
describe('компас и главная цифра — тот же расчётный автопуть, что и на карте (07.09: "Мишенная сопка")', () => {
  it('onPlaceClick передан VedarMap и несёт настоящее имя места в pointCard', () => {
    expect(TRAIL).toContain("onPlaceClick={p => setPointCard({ kind: 'pin', lat: p.lat, lng: p.lng, name: p.name })}");
  });

  it('routeFromCard использует имя места, если оно известно, иначе честное «Точка на карте»', () => {
    expect(TRAIL).toContain("title: pointCard.name ?? 'Точка на карте'");
  });

  it('PointCard получает имя и показывает его заголовком (не «Точка на карте» поверх настоящего места)', () => {
    expect(TRAIL).toContain('name={pointCard.name ?? null}');
    const CARD = readFileSync(join(process.cwd(), 'components/field/PointCard.tsx'), 'utf-8');
    expect(CARD).toContain("const title = kind === 'me' ? 'Я' : (name ?? 'Точка на карте');");
  });

  it('калькулятор компаса/дистанции для calculatedPreview — геометрия (haversine/bearingDeg), не хожалый темп', () => {
    expect(TRAIL).toContain('const calcDest = calculatedPreview?.route.destinationSnapped ?? null;');
    expect(TRAIL).toContain('const calcDistKm = calcDest && coords ? haversine(coords.lat, coords.lng, calcDest.lat, calcDest.lon) : null;');
    expect(TRAIL).toMatch(/const calcBearing = calcDest && coords && fixUsableForNavigation\(coords\.accuracy \?\? null\)/);
    // ETA — durationS самого провайдера (то же число, что в карточке предпросмотра), не paceFromTrack.
    expect(TRAIL).toContain("const calcEtaLabel = calculatedPreview ? `~${formatEta(calculatedPreview.route.durationS / 3600)}` : null;");
  });

  it('компас переключается на calcBearing, пока автопуть на карте', () => {
    expect(TRAIL).toContain('targetBearing={calculatedPreview ? calcBearing : targetBearing}');
  });

  it('главная цифра (свёрнутый и развёрнутый лист) проверяет calculatedPreview ПЕРВЫМ — раньше dataConflict/isLoadingRoute/waypoints.length', () => {
    // Оба места рендера (свёрнутый лист и развёрнутый) начинают ветку с
    // calculatedPreview — старые ветки (isLoadingRoute, waypoints.length===0,
    // approach?.dataConflict) остаются, просто уже не первыми в цепочке.
    const occurrences = [...TRAIL.matchAll(/\{calculatedPreview \? \(/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    expect(TRAIL).toContain('caption="до цели"');
  });

  it('«N из M» в шапке молчит, пока на карте расчётный автопуть — он про другой маршрут', () => {
    expect(TRAIL).toContain('checkpoint={!calculatedPreview && waypoints.length > 1');
  });

  it('«Сохранить карту» — быстрое действие, доступное без разворота листа (07.09: «нет кнопки сохранить маршрут»)', () => {
    // Строка «Карта не сохранена — в поле не откроется» стоит наверху КАЖДОГО
    // состояния экрана (FieldStatusStrip), а до этой правки нажать на неё
    // было нечего без разворота листа и прокрутки до «Сохранить полевой
    // пакет». Действие живёт в ТОЙ ЖЕ панели (fieldActions), которая видна
    // всегда — панель просто прячет подписи в свёрнутом виде, а не саму кнопку.
    const at = TRAIL.indexOf('if (hasRoute && mapPlan && !savedMap) {');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('\n    }\n', at));
    expect(body).toContain("id: 'save_pack'");
    expect(body).toContain('onPress: () => { const id = crumbsRouteRef.current; if (id) void saveMap(id); }');
    // Снимается САМО, как только карта сохранена — вторая копия «Сохранить»
    // рядом с уже готовой картой спорила бы, какая из кнопок главная.
    expect(TRAIL).toContain('if (hasRoute && mapPlan && !savedMap) {');
  });

  it('«всего X км» — рядом с «до следующей точки», не взамен', () => {
    const total = [...TRAIL.matchAll(/totalLabel=\{waypoints\.length > 1 && progress\.totalKm > 0 \? `всего \$\{fmtKm\(progress\.totalKm\)\}` : null\}/g)];
    expect(total.length).toBeGreaterThanOrEqual(2);
    const FD = readFileSync(join(process.cwd(), 'components/field/FieldDistance.tsx'), 'utf-8');
    expect(FD).toContain('totalLabel: string | null;');
    expect(FD).toContain('{p.totalLabel && (');
  });
});

/**
 * Владелец 08.09: «Сменить маршрут» → «Рекомендуемые» → тап «Начать» →
 * ничего не происходит. Модалка закрывается (selectRoute), но
 * fetchRouteWaypoints видел success:false от /api/routes/[id] и просто
 * `return`ал — activeRouteTitle оставался от ПРЕЖНЕГО маршрута, и человеку
 * казалось, что тап по «Начать» не сработал вовсе. Третье состояние по
 * §4.0: «сервер отказал» — не то же самое, что «маршрут не выбран», и
 * должно быть названо, а не спрятано за молчаливым return.
 */
describe('отказ загрузки маршрута — словами и с повтором, не тишиной (08.09)', () => {
  it('fetchRouteWaypoints запоминает id и сбрасывает старый отказ на каждой попытке', () => {
    const at = TRAIL.indexOf('const fetchRouteWaypoints = useCallback((routeId: string) => {');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, at + 900);
    expect(body).toContain('lastRouteIdRef.current = routeId;');
    expect(body).toContain('setRouteLoadError(null);');
  });

  it('success:false от сервера для НОВОГО маршрута (без кэша) — честный routeLoadError, не тихий return', () => {
    const at = TRAIL.indexOf("if (typeof j !== 'object' || j === null || !(j as Record<string, unknown>).success) {");
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('\n          return;\n        }', at));
    expect(body).toContain('if (!hadCache)');
    expect(body).toContain('setRouteLoadError(err)');
  });

  it('кэш ЕСТЬ (обновление существующего маршрута) — отказ сети не показывается: показывать нечего нового, а не поломку', () => {
    // hadCache — единственное условие показа routeLoadError в обеих ветках
    // (success:false и .catch сети): у уже открытого маршрута кэш уже на
    // экране, и «не смог обновить» — не то же самое, что «ничего нет».
    const occurrences = [...TRAIL.matchAll(/if \(!hadCache\)/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('карта подводит кадр под новый каталожный маршрут — тем же приёмом, что и у расчётного автопути', () => {
    // Владелец 08.09, «Авачинский перевал»: маршрут выбрался (заголовок,
    // счёт точек, расстояние — всё сменилось), а на карте не видно ничего —
    // линия рисуется корректно, но остаётся за кадром той точки, где стоял
    // человек, если её никто не подвёл. Без mapCtl.fitLine() это выглядит
    // как «трек не строится», хотя данные пришли.
    const at = TRAIL.indexOf('// Новый КАТАЛОЖНЫЙ маршрут');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('}, [mapCtl, track, waypoints]);', at));
    expect(body).toContain('mapCtl.fitLine(line.map(([lat, lng]) => [lng, lat]));');
    expect(body).toContain('track && track.length >= 2 ? track');
    expect(body).toContain('waypoints.length >= 2 ? waypoints.map(w => [w.lat, w.lng] as [number, number])');
  });

  it('банер отказа — вверху тела листа, видим в любом его состоянии, с кнопкой «Повторить»', () => {
    const at = TRAIL.indexOf('{routeLoadError && (');
    expect(at).toBeGreaterThan(0);
    const body = TRAIL.slice(at, TRAIL.indexOf('\n        )}', at));
    expect(body).toContain('{routeLoadError}');
    expect(body).toContain("onClick={() => { const id = lastRouteIdRef.current; if (id) fetchRouteWaypoints(id); }}");
    expect(body).toContain('Повторить');
  });
});
