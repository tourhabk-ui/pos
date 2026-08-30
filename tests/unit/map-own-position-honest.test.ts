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
