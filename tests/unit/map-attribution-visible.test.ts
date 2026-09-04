/**
 * Сторож: атрибуция OSM/Copernicus стоит там, где её реально видно.
 *
 * 04.09, проверка владельца: строка «© OpenStreetMap contributors» лежала
 * в источниках стиля VedarMap честно, но контрол, который её выводит на
 * экран, MapLibre ставит по умолчанию в bottomright — а этот угол на
 * экране «На маршруте» НАВСЕГДА закрыт нижним листом приборов
 * (_PlanningClient, fixed inset-x-0 bottom-0, минимум 32vh, непрозрачный,
 * §2: «критичные приборы... всегда непрозрачные»). Атрибуция была
 * записана, но не показана ни разу — тот же класс разрыва, что §4.0 бьёт
 * в других формах: данные есть, а наружу они не дошли.
 *
 * У Leaflet-фолбэка (та же точка на том же экране, пока свой пакет ещё не
 * собран) — тот же диагноз, тем же углом bottomright.
 *
 * Починка — НЕ убрать нижний лист (он там по решению владельца 02.09) и
 * НЕ выключить атрибуцию (по лицензии ODbL это не выбор), а увести
 * контрол в угол, который лист не занимает.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAP = readFileSync(join(process.cwd(), 'components/shared/VedarMap.tsx'), 'utf-8');
const LEAFLET = readFileSync(join(process.cwd(), 'components/shared/LeafletMap.tsx'), 'utf-8');
const CLIENT = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

describe('VedarMap: атрибуция не в мёртвом углу', () => {
  it('встроенный bottom-right контрол отключён, свой стоит в top-right', () => {
    expect(MAP).toMatch(/attributionControl:\s*false/);
    expect(MAP).toMatch(/map\.addControl\(new maplibre\.AttributionControl\(\{ compact: true \}\), 'top-right'\)/);
  });

  it('не откатились обратно на дефолтный bottom-right', () => {
    expect(MAP).not.toMatch(/attributionControl:\s*\{\s*compact:\s*true\s*\}/);
  });
});

describe('LeafletMap: атрибуция управляема снаружи, дефолт не тронут', () => {
  it('проп attributionPosition существует и по умолчанию не меняет поведение', () => {
    expect(LEAFLET).toMatch(/attributionPosition\?:/);
    // Встроенный контрол включается ТОЛЬКО когда угол не задан явно —
    // семь других поверхностей с LeafletMap не передают этот проп и
    // получают ровно то же поведение, что было.
    expect(LEAFLET).toMatch(/attributionControl:\s*attribution !== false && !attributionPosition/);
  });

  it('свой контрол ставится в заданный угол, тем же текстом', () => {
    const at = LEAFLET.indexOf('L.control.attribution({');
    expect(at, 'кастомный контрол не найден').toBeGreaterThan(0);
    const body = LEAFLET.slice(at, at + 200);
    expect(body).toMatch(/position:\s*attributionPosition/);
  });
});

describe('_PlanningClient: экран «На маршруте» уводит атрибуцию из-под нижнего листа', () => {
  it('LeafletMap-фолбэк получает attributionPosition явно', () => {
    // _PlanningClient рисует LeafletMap пятью разными местами (мини-пикеры
    // координат, превью маршрута) — базовый фолбэк на весь экран узнаём по
    // соседству с autoPanDoneRef, уникальному только там.
    const at = CLIENT.indexOf('autoPanDoneRef={autoPanDoneRef}');
    expect(at, 'полноэкранный LeafletMap-фолбэк не найден').toBeGreaterThan(0);
    const body = CLIENT.slice(at - 300, at + 700);
    expect(body).toMatch(/attributionPosition="topleft"/);
  });
});
