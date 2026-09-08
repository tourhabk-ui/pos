/**
 * Полевой экран «На маршруте»: приборы не спорят друг с другом, а управление
 * не лежит под чужой панелью.
 *
 * ── Замер 08.09 на /planning?mode=trail (мобильный кадр 390×844) ───────────
 *
 * При ЗАПРЕЩЁННОЙ геолокации экран одновременно утверждал три несовместимые
 * вещи: оверлей карты — «GPS работает — координаты активны», строка приборов
 * — «Ищем спутники…», карточка ниже — «Своё положение не определено». Ни
 * одно из трёх не было помечено как догадка, а человек в поле решает по ним,
 * верить ли стрелке.
 *
 * Тем же замером: кнопка «+» карты лежала в y 12–42 при липкой полосе вкладок
 * 0–47 (z-40 поверх карты z-0) — приблизить карту кнопкой было нельзя вовсе.
 * Атрибуция OpenStreetMap, перенесённая 04.09 из мёртвого низа в topleft,
 * оказалась в (0,0,263×17), то есть под той же полосой: elementFromPoint в её
 * точке возвращал полосу вкладок. Лицензия CC-BY-SA требует, чтобы ссылка
 * была видна.
 *
 * И офлайн-полоса (fixed, z-120) накрывала полосу вкладок целиком, обещая при
 * этом «СОС и карта работают» — не зная ни про пакет карты, ни про то,
 * поднялся ли Service Worker.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MAP = read('components/shared/LeafletMap.tsx');
const CLIENT = read('app/planning/_PlanningClient.tsx');
const BANNER = read('components/PWA/OfflineBanner.tsx');

describe('карта не рассказывает про GPS', () => {
  it('оверлей «тайлов нет» не утверждает, что геолокация работает', () => {
    // Компонент карты о геолокации не знает ничего: у него нет ни фикса, ни
    // разрешения, ни ошибки датчика.
    expect(strip(MAP)).not.toMatch(/GPS работает/);
    expect(strip(MAP)).not.toMatch(/координаты активны/);
  });

  it('но говорит то, что знает: подложки нет, точки и линии на месте', () => {
    expect(strip(MAP)).toMatch(/Подложка не загрузилась/);
  });
});

describe('строка приборов: «ищем» и «не отвечает» — разные ответы', () => {
  it('отказ датчика показывается раньше, чем «Ищем спутники…»', () => {
    // Иначе сообщение об отказе недостижимо ровно в том случае, для которого
    // написано: без единого фикса fix.state === 'none' навсегда.
    const src = strip(CLIENT);
    const msg = src.indexOf("if (gpsMessage) return");
    const none = src.indexOf("fix.state === 'none') return { tone: 'info', text: 'Ищем спутники…' }");
    expect(msg, 'ветка gpsMessage пропала').toBeGreaterThan(-1);
    expect(none, 'ветка «Ищем спутники…» пропала').toBeGreaterThan(-1);
    expect(msg, '«Ищем спутники…» снова перехватывает отказ датчика').toBeLessThan(none);
  });
});

describe('управление картой не уезжает под полосу вкладок', () => {
  it('у карты есть отступ сверху, и он приходит от вызывающего', () => {
    expect(MAP).toMatch(/topInset\?: number/);
    expect(strip(MAP)).toMatch(/leaflet-top\.leaflet-right/);
    expect(strip(MAP)).toMatch(/paddingTop = `\$\{topInset\}px`/);
  });

  it('полевой экран передаёт ИЗМЕРЕННУЮ высоту полосы, а не число', () => {
    // Высота зависит от шрифта и отступов кнопок: вписанная копия разойдётся
    // с полосой при первой же правке вёрстки.
    const src = strip(CLIENT);
    expect(src).toMatch(/topInset=\{topInset\}/);
    expect(src).toMatch(/tabBarRef/);
    expect(src).toMatch(/setTabBarH\(el\.getBoundingClientRect\(\)\.height\)/);
    expect(src).not.toMatch(/topInset=\{\d+\}/);
  });
});

describe('офлайн-полоса', () => {
  it('не обещает того, чего не знает', () => {
    expect(strip(BANNER)).not.toMatch(/СОС и карта работают/);
  });

  it('называет отказ офлайн-контура, когда он ТОЧНО не поднялся', () => {
    // Состояние есть в sw-status и уже показывается на полевом экране —
    // полоса обязана говорить то же самое, а не обратное.
    expect(strip(BANNER)).toMatch(/useSwRegistration/);
    expect(strip(BANNER)).toMatch(/'failed' \|\| sw\.state === 'unsupported'/);
  });

  it('стоит в потоке, а не поверх шапки экрана', () => {
    // Замер: fixed z-120 накрывал полосу вкладок (0–47) целиком, и офлайн
    // человек не видел, на какой он вкладке.
    expect(strip(BANNER)).toMatch(/position: 'sticky'/);
    expect(strip(BANNER)).not.toMatch(/position: 'fixed'/);
  });
});

describe('цвет строки состояния объявлен один раз', () => {
  const LAYOUT = read('app/layout.tsx');
  it('themeColor живёт в viewport, а не в metadata и не в ручном теге', () => {
    expect(LAYOUT).toMatch(/export const viewport[\s\S]{0,900}themeColor:/);
    expect(LAYOUT).not.toMatch(/manifest: '\/manifest\.json',\s*\n\s*themeColor:/);
    expect(LAYOUT).not.toMatch(/<meta name="theme-color"/);
  });
});

/**
 * Рассчитанный путь виден на карте, откуда бы его ни попросили.
 *
 * Жалоба владельца 08.09: «когда выбираешь точку на карте, маршрут строится,
 * а когда из списка — нет». Разбор нашёл две причины, обе настоящие:
 *
 *  1. ГЛАВНАЯ, и она общая для обеих подложек: линия попадала на фоновую
 *     карту только из ОТКРЫТОГО превью. С карточки точки превью
 *     открывалось само (cardBuildRef) — линия была; из списка результат
 *     ложился строкой «Автомобильный путь от вашего старта», и до нажатия
 *     на карте не было ничего;
 *  2. вдобавок у запасного Leaflet ветки рассчитанного пути не было вовсе.
 *     Своя карта сегодня собрана на все десять районов и сетку клеток, но
 *     Leaflet остаётся там, где адрес хранилища не настроен или точка вне
 *     собранного.
 *
 * Замер после правки (Leaflet, мобильный кадр): полилиний в overlay-слое
 * фоновой карты 1 → 3 сразу после выбора цели, без единого лишнего тапа, и
 * список готовых треков остаётся на экране.
 */
describe('рассчитанный путь на фоновой карте', () => {
  const src = strip(CLIENT);

  it('линия берётся из общего источника, а не только из открытого превью', () => {
    expect(src).toMatch(/const mapCalculated = calculatedPreview\?\.route \?\? autoBuiltRoute/);
    // Обе подложки читают ОДНО состояние — иначе они снова разойдутся.
    expect(src).toMatch(/const calc = mapCalculated;/);
  });

  it('Leaflet-фон рисует её тем же стандартом, что и превью', () => {
    // Свой стиль в объекте геометрии — запрещён (§12): правило, написанное
    // трижды, — это три правила.
    const bg = src.slice(src.indexOf('const backgroundMapMarkers'), src.indexOf('const backgroundMapMarkers') + 1400);
    expect(bg).toMatch(/calculatedCarToLeafletCoordinates\(calc\)/);
    expect(bg).toMatch(/calculatedCarLine\(\)/);
    expect(bg).toMatch(/mapCalculated/);
  });

  it('превью само не открывается — список готовых треков не прячется', () => {
    // Платформа предпочитает снятый трек рассчитанному подъезду: открыть
    // превью самому значило бы закрыть собой список путей.
    expect(src).not.toMatch(/buildAutoOpenRef/);
  });

  it('каталожное превью снимает рассчитанное — одно за раз', () => {
    const open = src.slice(src.indexOf('function openPreview'), src.indexOf('function openPreview') + 1200);
    expect(open).toMatch(/setCalculatedPreview\(null\)/);
  });
});

/**
 * Цель, до которой нет дороги, — это подъезд, а не отказ.
 *
 * Порог привязки к дорожному графу — 1 км, а цели в списке это МЕСТА:
 * вершины, озёра, источники. До вершины Горелого дороги нет ни одной, и
 * прежняя политика («любая привязка дальше порога — not_found») отвечала
 * «путь не найден» на каждую такую цель. Тап по карте попадал рядом с
 * дорогой и работал — ровно та разница, на которую жаловался владелец.
 *
 * Опасность, ради которой ставился порог (провайдер молча снапит далёкую
 * точку и рисует путь туда, где дороги нет), закрыта не отказом, а ИМЕНЕМ:
 * подъезд назван подъездом, остаток до цели — числом.
 */
describe('подъезд к цели без дороги', () => {
  const src = strip(CLIENT);
  const API = strip(read('app/api/routes/build/route.ts'));
  const PROVIDER = strip(read('lib/on-route/route-provider.ts'));

  it('отказ остался только для непривязанного СТАРТА', () => {
    expect(PROVIDER).toMatch(/carRouteReach\(result\.route\) === 'unusable'/);
    expect(PROVIDER).not.toMatch(/if \(withinSnapTolerance\(result\.route\)\) return result;/);
  });

  it('сервер называет подъезд подъездом и говорит остаток', () => {
    expect(API).toMatch(/reach === 'approach'/);
    expect(API).toMatch(/Подъезд к/);
    expect(API).toMatch(/formatApproachGap\(gap\)/);
  });

  it('экран показывает заголовок СЕРВЕРА, а не свою константу', () => {
    // Константа «Путь на автомобиле» перекрывала и имя цели, и предупреждение
    // о том, что дорога до цели не доходит.
    expect(src).toMatch(/\{r\.title \|\| 'Путь на автомобиле'\}/);
    expect(src).not.toMatch(/truncate">Путь на автомобиле</);
  });

  it('остаток пути пешком назван и в строке, и рядом с линией', () => {
    expect(src).toMatch(/дальше пешком \$\{formatApproachGap\(gapM\)\}/);
    expect(src).toMatch(/Дорога кончается за/);
    expect(src).toMatch(/carRouteReach\(calculatedPreview\.route\) === 'approach'/);
  });
});
