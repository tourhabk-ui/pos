/**
 * Синей точки нет, пока нет фикса.
 *
 * Владелец 10.08, глядя на карту «На маршруте»: «а где геолокация, которая
 * определяет моё положение?» На карте было несколько синих кружков, и один из
 * них не был им.
 *
 * Маркер «я здесь» и круг точности создавались СРАЗУ, в центре карты, с
 * радиусом 1000 м «до первого фикса». Центр карты — это середина маршрута, а
 * не человек. Если фикса не случалось (отказ в доступе, помещение, нет неба),
 * точка так и оставалась там — и выглядела подтверждённым положением, с
 * пульсацией и кругом точности, как настоящая.
 *
 * На экране навигации это худший вид сегодняшнего дефекта: не «нет данных»,
 * а выдуманные данные, по которым человек идёт.
 *
 * Вторая половина — отказ геолокации глотался пустым обработчиком. «GPS не
 * дал фикса» и «вот вы» выглядели на экране одинаково.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAP = readFileSync(join(process.cwd(), 'components/shared/LeafletMap.tsx'), 'utf-8');

/** Тело блока геолокации — от флага до конца watchPosition. */
const geoBlock = MAP.slice(
  MAP.indexOf('if (showUserLocation'),
  MAP.indexOf('}).catch(() => {'),
);

describe('своё положение рисуется только из настоящего фикса', () => {
  it('блок геолокации вообще найден', () => {
    // Иначе проверки ниже молча стали бы бессодержательными.
    expect(geoBlock.length).toBeGreaterThan(500);
    expect(geoBlock).toContain('watchPosition');
  });

  it('маркер не ставится в центр карты', () => {
    // Ровно та строка, что рисовала человека в середине маршрута.
    expect(geoBlock).not.toMatch(/L\.marker\(\s*\[\s*center\[0\]/);
    expect(geoBlock).not.toMatch(/L\.circle\(\s*\[\s*center\[0\]/);
  });

  it('радиус точности берётся из фикса, а не из константы', () => {
    // «radius: 1000» до фикса — это не точность, а выдумка с видом измерения.
    expect(geoBlock).not.toMatch(/radius:\s*1000/);
    expect(geoBlock).toMatch(/radius:\s*acc/);
  });

  it('маркер рождается внутри обработчика успеха', () => {
    const success = geoBlock.slice(geoBlock.indexOf('(pos) => {'));
    expect(success).toMatch(/L\.marker\(\s*\[lat, lng\]/);
  });
});

describe('отказ геолокации назван, а не проглочен', () => {
  it('обработчик ошибки не пустой', () => {
    expect(geoBlock).not.toMatch(/\(\)\s*=>\s*\{\s*\/\*[^*]*\*\/\s*\}/);
    expect(geoBlock).toContain('setGeoDenied(true)');
  });

  it('успешный фикс снимает сообщение об отказе', () => {
    // Иначе разовая ошибка навсегда оставила бы надпись поверх работающей карты.
    expect(geoBlock).toContain('setGeoDenied(false)');
  });

  it('человеку показывается текст, а не пустое место', () => {
    expect(MAP).toMatch(/geoDenied\s*&&/);
    expect(MAP).toContain('Своё положение не определено');
  });

  it('сообщение появляется только там, где своё положение вообще обещано', () => {
    expect(MAP).toMatch(/showUserLocation\s*&&\s*geoDenied/);
  });
});

describe('карта не гоняется за шумным фиксом', () => {
  /**
   * Живой скрин владельца 30.08: GPS ±1000 м, «карта с точкой скачут,
   * невозможно что-либо сделать». `panTo` срабатывал на КАЖДЫЙ фикс при
   * zoom >= 12 — при плохом небе соседние фиксы разбросаны в пределах
   * заявленной точности, и вид карты дёргался вслед за ними. Центрирование
   * законно один раз, при появлении точки («вот вы») — дальше камерой
   * распоряжается тот, кто её держит.
   */
  it('panTo вызывается только на первом фиксе, не на каждом', () => {
    expect(geoBlock).toMatch(/isFirstFix\s*&&\s*map\.getZoom\(\)\s*>=\s*12/);
    expect(geoBlock).not.toMatch(/if\s*\(\s*map\.getZoom\(\)\s*>=\s*12\s*\)\s*\{\s*\n\s*map\.panTo/);
  });

  it('isFirstFix вычисляется ДО создания маркера — иначе он всегда false', () => {
    const at = geoBlock.indexOf('const isFirstFix');
    const markerAt = geoBlock.indexOf('userMarker = L.marker(');
    expect(at).toBeGreaterThan(0);
    expect(markerAt).toBeGreaterThan(at);
  });
});

describe('panTo-один-раз переживает ремонт полноэкранной карты (31.08)', () => {
  /**
   * «линя встала но карта скачет» — владелец сообщил это СРАЗУ после того,
   * как боевой GPS-трек стал geometry «Зеленовские озерки». isFirstFix
   * живёт внутри useEffect-замыкания ОДНОГО инстанса Leaflet: полноэкранный
   * mapMarkers меняет identity на каждом GPS-тике (crumbs/approachLine в
   * зависимостях), LeafletMap пересоздаёт карту заново, и isFirstFix снова
   * становится «первый» — panTo дёргает камеру на каждом ремонте, хотя сам
   * инстанс карты для человека один и тот же. Проп autoPanDoneRef живёт у
   * вызывающего компонента (_PlanningClient) и переживает пересоздание.
   */
  it('пан гасится общим для ремонтов флагом, не только isFirstFix', () => {
    expect(geoBlock).toMatch(/isFirstFix\s*&&\s*map\.getZoom\(\)\s*>=\s*12\s*&&\s*!autoPanDoneRef\?\.current/);
  });

  it('флаг взводится сразу после пана — не остаётся false навсегда', () => {
    const panAt = geoBlock.indexOf('map.panTo([lat, lng]');
    expect(panAt).toBeGreaterThan(0);
    const after = geoBlock.slice(panAt, panAt + 200);
    expect(after).toMatch(/autoPanDoneRef\.current\s*=\s*true/);
  });

  it('проп необязателен — карты без вызывающего рефа не ломаются', () => {
    expect(MAP).toMatch(/autoPanDoneRef\?:\s*\{\s*current:\s*boolean\s*\}/);
  });
});

describe('вид карты переживает непрошеный ремонт инстанса (31.08)', () => {
  /**
   * После autoPanDoneRef владелец сказал: «она как скакала так и скачет».
   * Скакал не panTo. Эффект держит ВЕСЬ инстанс: смена identity markers →
   * map.remove() → новый L.map() с center/zoom из пропов → fitBounds по всем
   * маркерам, и ещё дважды (rAF + setTimeout 250). В полноэкранном режиме
   * markers меняется на каждом GPS-фиксе, поэтому вид сбрасывался туда, где
   * человек его не оставлял — приблизился, а его отбросило.
   *
   * Различать надо ремонт ПРОШЕНЫЙ (сменились center/zoom — кнопка «Карта»,
   * выбор маршрута: новый вид и есть смысл действия) и НЕПРОШЕНЫЙ (пропы те
   * же, виноваты маркеры). Первый работает как раньше, второй восстанавливает
   * вид человека и не зовёт fitBounds.
   */
  it('вид запоминается в cleanup — ДО разрушения карты', () => {
    const cleanupAt = MAP.indexOf('return () => {\n      cancelled = true;');
    expect(cleanupAt).toBeGreaterThan(0);
    const cleanup = MAP.slice(cleanupAt);
    const captureAt = cleanup.indexOf('viewRef.current = {');
    const removeAt = cleanup.indexOf('mapRef.current.remove()');
    expect(captureAt).toBeGreaterThan(0);
    expect(removeAt).toBeGreaterThan(captureAt);
  });

  it('прошеный ремонт отличается от непрошеного по пропам вида', () => {
    expect(MAP).toMatch(/const viewPropsKey = `\$\{center\[0\]\},\$\{center\[1\]\},\$\{zoom\}`/);
    expect(MAP).toMatch(/const deliberateView = viewPropsRef\.current !== viewPropsKey/);
    expect(MAP).toMatch(/const restoredView = deliberateView \? null : viewRef\.current/);
  });

  it('карта создаётся на восстановленном виде, когда он есть', () => {
    expect(MAP).toMatch(/center: restoredView\s*\n?\s*\?\s*L\.latLng\(restoredView\.lat, restoredView\.lng\)/);
    expect(MAP).toMatch(/zoom: restoredView \? restoredView\.zoom : zoom/);
  });

  it('восстановленный вид сразу считается подогнанным — fitBounds его не отменит', () => {
    // Подгонка живёт в эффекте маркеров (см. describe ниже) и спрашивает
    // fitDoneRef. Восстановление вида обязано взвести этот флаг, иначе
    // первая же отрисовка маркеров подогнала бы вид и отменила восстановление.
    expect(MAP).toMatch(/fitDoneRef\.current = Boolean\(restoredView\)/);
  });
});

describe('маркеры рисуются на живой карте, а не пересборкой инстанса (31.08)', () => {
  /**
   * Корень «она как скакала так и скачет». Создание карты и отрисовка
   * маркеров сидели в ОДНОМ эффекте, и `markers` был в его зависимостях:
   * любое обновление набора точек означало map.remove() и полную сборку
   * заново — новый DOM, новый тайловый слой, повторная закачка тайлов. В
   * полноэкранном режиме набор меняется на каждом GPS-фиксе (живой след,
   * линия подхода), то есть карта под рукой человека перезагружалась целиком
   * каждые несколько секунд. Восстановление вида (describe выше) убирает
   * прыжок координат, но не мигание и не перекачку тайлов.
   */
  it('markers НЕ в зависимостях эффекта жизненного цикла', () => {
    // Массив зависимостей эффекта карты — тот, что содержит locationPriority.
    const depsAt = MAP.indexOf('}, [center[0], center[1], zoom');
    expect(depsAt).toBeGreaterThan(0);
    const deps = MAP.slice(depsAt, MAP.indexOf(']);', depsAt));
    expect(deps).not.toMatch(/\bmarkers\b/);
    expect(deps).toContain('locationPriority');
  });

  it('центр разложен на числа — литерал [a, b] у вызывающего не пересоздаёт карту', () => {
    expect(MAP).toMatch(/\}, \[center\[0\], center\[1\], zoom/);
  });

  it('обработчики через ref — инлайновая стрелка не пересоздаёт карту', () => {
    expect(MAP).toMatch(/onMapClickRef\.current\?\.\(e\.latlng\.lat, e\.latlng\.lng\)/);
    expect(MAP).toMatch(/onMarkerClickRef\.current\?\.\(markerId\)/);
    const depsAt = MAP.indexOf('}, [center[0], center[1], zoom');
    const deps = MAP.slice(depsAt, MAP.indexOf(']);', depsAt));
    expect(deps).not.toMatch(/onMarkerClick|onMapClick/);
  });

  it('отдельный эффект маркеров снимает прошлые слои и рисует новые', () => {
    const at = MAP.indexOf('}, [markers, mapEpoch]);');
    expect(at).toBeGreaterThan(0);
    const body = MAP.slice(MAP.lastIndexOf('useEffect(() => {', at), at);
    expect(body).toContain('drawnRef.current.forEach');
    expect(body).toContain('cluster.clearLayers()');
    expect(body).toContain('drawnRef.current = drawn;');
    // Карта в этом эффекте берётся, а НЕ создаётся и не разрушается.
    expect(body).not.toContain('L.map(');
    expect(body).not.toContain('mapRef.current.remove()');
  });

  it('снятие слоя не глушится пустым catch', () => {
    // §4.0: отказ, превращённый в тишину, читается как «маркеров нет».
    const at = MAP.indexOf('[LeafletMap] layer remove failed');
    expect(at).toBeGreaterThan(0);
  });

  it('подгонка вида — один раз на инстанс, а не на каждый набор маркеров', () => {
    const at = MAP.indexOf('}, [markers, mapEpoch]);');
    const body = MAP.slice(MAP.lastIndexOf('useEffect(() => {', at), at);
    expect(body).toMatch(/if \(fitDoneRef\.current \|\| allCoords\.length < 2\) return;/);
    expect(body).toMatch(/fitDoneRef\.current = true;/);
    expect(body.indexOf('fitDoneRef.current = true;'))
      .toBeLessThan(body.indexOf('map.fitBounds('));
  });

  it('эпоха карты перерисовывает маркеры на новом инстансе', () => {
    // Иначе после законного пересоздания (смена center/zoom, retry) карта
    // осталась бы без единого маркера: слои рисовались на прошлой.
    expect(MAP).toMatch(/setMapEpoch\(\(n\) => n \+ 1\)/);
    expect(MAP).toMatch(/\}, \[markers, mapEpoch\]\);/);
  });

  it('умершие вместе с картой слои не переносятся на новый инстанс', () => {
    const cleanupAt = MAP.indexOf('return () => {\n      cancelled = true;');
    const cleanup = MAP.slice(cleanupAt, MAP.indexOf('}, [center[0]', cleanupAt));
    expect(cleanup).toContain('drawnRef.current = [];');
    expect(cleanup).toContain('LRef.current = null;');
  });
});
