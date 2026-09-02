/**
 * След пути и запись о скачанной карте.
 *
 * Обе вещи проверяются в поле, где чинить нечем. След — единственный способ
 * вернуться, когда отказало остальное; запись о карте — единственное, по чему
 * человек решает, готов он выходить или нет. Поэтому здесь стерегутся не
 * функции, а обещания: не терять пройденное, не врать про сохранённое.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addCrumb, parseCrumbs, serializeCrumbs, crumbsDistanceKm, crumbsKey,
  CRUMB_MIN_STEP_M, CRUMB_MAX, type Crumb,
} from '@/lib/offline/breadcrumbs';
import {
  parseSavedMap, savedMapKey, savedAtLabel, savedMapSummary, type SavedMapRecord,
} from '@/lib/offline/saved-map';

const KM_LAT = 111.32;
const T0 = 1_700_000_000_000;

/** Точка в n метрах к северу от базовой. */
function north(m: number, t = T0) {
  return { lat: 53 + m / 1000 / KM_LAT, lng: 158.65, t };
}

describe('след пути пишется по расстоянию, а не по времени', () => {
  it('стояние на месте не плодит крошек', () => {
    // Час у ручья не должен съесть квоту хранилища.
    let crumbs: Crumb[] = [];
    for (let i = 0; i < 200; i++) crumbs = addCrumb(crumbs, north(1, T0 + i * 1000));
    expect(crumbs.length).toBe(1);
  });

  it('шаг больше порога — крошка принята', () => {
    const first = addCrumb([], north(0));
    const second = addCrumb(first, north(CRUMB_MIN_STEP_M + 5, T0 + 60_000));
    expect(second.length).toBe(2);
    expect(second).not.toBe(first);
  });

  it('отклонённая крошка возвращает ТОТ ЖЕ массив — по нему видно, что писать на диск не надо', () => {
    const one = addCrumb([], north(0));
    expect(addCrumb(one, north(1, T0 + 5000))).toBe(one);
  });

  it('битые координаты не попадают в след', () => {
    expect(addCrumb([], { lat: NaN, lng: 158, t: T0 })).toEqual([]);
    expect(addCrumb([], { lat: 53, lng: Infinity, t: T0 })).toEqual([]);
  });

  it('точка вне Камчатки не попадает в след (правка 30.08 — скрин владельца: голубая линия следа до Магаданской области)', () => {
    // Тот же диагноз, что 17.08 у трека из БД (lib/routes/track.ts): «конечное
    // число» — не «точка на Камчатке». Живой след писался без этой проверки —
    // одна точка от сетевого фолбэка геолокации оставалась в следе навсегда,
    // потому что все соседние фиксы дальше минимального шага именно от НЕЁ.
    const magadan = { lat: 62, lng: 145, t: T0 };
    expect(addCrumb([], magadan)).toEqual([]);
    // И не пролезает вторым шагом поверх уже принятой точки.
    const one = addCrumb([], north(0));
    expect(addCrumb(one, { ...magadan, t: T0 + 60_000 })).toBe(one);
  });

  it('parseCrumbs отсеивает недостоверные точки, уже лежащие в хранилище — самолечение при следующем открытии экрана', () => {
    const raw = JSON.stringify([
      [53.01, 158.65, T0],
      [62, 145, T0 + 1000],       // брак — за пределами Камчатки
      [53.02, 158.66, T0 + 2000],
    ]);
    const restored = parseCrumbs(raw);
    expect(restored).toHaveLength(2);
    expect(restored.every(c => c.lat >= 50 && c.lat <= 66 && c.lng >= 154 && c.lng <= 175)).toBe(true);
  });

  it('переполнение режет ДАЛЬНИЙ конец: возвращаются по ближнему', () => {
    let crumbs: Crumb[] = [];
    for (let i = 0; i < CRUMB_MAX + 50; i++) crumbs = addCrumb(crumbs, north(i * 30, T0 + i * 1000));
    expect(crumbs.length).toBe(CRUMB_MAX);
    // Последняя точка — самая свежая.
    expect(crumbs[crumbs.length - 1].t).toBe(T0 + (CRUMB_MAX + 49) * 1000);
  });
});

describe('след переживает перезапуск', () => {
  it('запись и чтение сохраняют путь', () => {
    let crumbs: Crumb[] = [];
    for (let i = 0; i < 10; i++) crumbs = addCrumb(crumbs, north(i * 40, T0 + i * 1000));
    const restored = parseCrumbs(serializeCrumbs(crumbs));
    expect(restored.length).toBe(crumbs.length);
    expect(restored[0]).toEqual(crumbs[0]);
    expect(crumbsDistanceKm(restored)).toBeCloseTo(crumbsDistanceKm(crumbs), 6);
  });

  it('мусор в хранилище — пустой след, а не падение экрана', () => {
    expect(parseCrumbs(null)).toEqual([]);
    expect(parseCrumbs('не json')).toEqual([]);
    expect(parseCrumbs('{"a":1}')).toEqual([]);
    expect(parseCrumbs('[[1],[2,3]]')).toEqual([]);
  });

  it('след привязан к маршруту — чужой не подмешается', () => {
    expect(crumbsKey('a')).not.toBe(crumbsKey('b'));
  });

  it('пройденное считается по следу', () => {
    let crumbs: Crumb[] = [];
    for (let i = 0; i <= 10; i++) crumbs = addCrumb(crumbs, north(i * 100, T0 + i * 1000));
    expect(crumbsDistanceKm(crumbs)).toBeCloseTo(1, 1);
  });
});

describe('запись о скачанной карте не врёт', () => {
  const rec: SavedMapRecord = {
    at: T0, tiles: 313, mb: 6, zooms: [12, 13, 14, 15],
    droppedZooms: [], coverage: 'corridor', bufferKm: 2, persisted: true,
  };

  it('в строке есть вес, дата и чем покрыто', () => {
    const s = savedMapSummary(rec, T0);
    expect(s).toContain('6 МБ');
    expect(s).toContain('полоса 2 км');
    expect(s).toContain('сегодня');
  });

  it('квадрат вокруг места не выдаётся за коридор', () => {
    // Разные обещания: одно про путь, другое про окрестность точки.
    const s = savedMapSummary({ ...rec, coverage: 'bbox', bufferKm: null }, T0);
    expect(s).toContain('квадрат вокруг места');
    expect(s).not.toContain('полоса');
  });

  it('дата читается словами', () => {
    const day = 24 * 3600 * 1000;
    expect(savedAtLabel(T0, T0)).toBe('сегодня');
    expect(savedAtLabel(T0 - day, T0)).toBe('вчера');
    expect(savedAtLabel(T0 - 10 * day, T0)).toMatch(/\d/);
  });

  it('мусор в записи читается как «не сохранено»', () => {
    // «Сохранено» без карты хуже, чем «не сохранено»: человек не проверит.
    expect(parseSavedMap(null)).toBeNull();
    expect(parseSavedMap('{}')).toBeNull();
    expect(parseSavedMap('не json')).toBeNull();
  });

  it('запись привязана к маршруту', () => {
    expect(savedMapKey('a')).not.toBe(savedMapKey('b'));
  });

  it('незакреплённое хранилище так и записано', () => {
    // Иначе экран пообещает сохранность, которой нет.
    expect(parseSavedMap(JSON.stringify({ at: T0, tiles: 1 }))?.persisted).toBe(false);
  });
});

describe('экран «На маршруте» пользуется этим', () => {
  const SCREEN = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('след пишется на диск по расстоянию, а не по таймеру', () => {
    expect(SCREEN).toMatch(/addCrumb\(before, \{ lat: pos\.coords\.latitude/);
    expect(SCREEN).toMatch(/if \(after !== before\)/);
    expect(SCREEN).toMatch(/serializeCrumbs\(after\)/);
  });

  it('след поднимается с диска при открытии, до первого фикса', () => {
    expect(SCREEN).toMatch(/parseCrumbs\(raw\)/);
  });

  it('брак, отсеянный при чтении, переписывается на диск сразу — не ждёт следующей крошки (правка 30.08)', () => {
    expect(SCREEN).toMatch(/serializeCrumbs\(restored\)/);
    expect(SCREEN).toMatch(/localStorage\.setItem\(crumbsKey\(routeId\), cleanedSerialized\)/);
  });

  it('след рисуется отдельной линией, а не подмешивается к маршруту', () => {
    // Маршрут — куда идти, след — где человек был. Возвращаются по второму.
    // Имя следа — константа стандарта линий (02.09): по нему MapLibre
    // отличает след от трека; на своей карте без этого он лёг толстым
    // зелёным «маршрутом». Само имя по-прежнему прибито — здесь.
    expect(SCREEN).toMatch(/title: TRAIL_TITLE/);
    const STANDARD = readFileSync(join(process.cwd(), 'lib/map/line-standard.ts'), 'utf-8');
    expect(STANDARD).toMatch(/export const TRAIL_TITLE = 'Ваш след'/);
    expect(SCREEN).toMatch(/crumbs\.map\(c => \[c\.lat, c\.lng\]/);
  });

  it('карта скачивается по нажатию, а не молча в фоне', () => {
    // Молчаливая докачка тратила трафик без спроса и не оставляла способа
    // проверить готовность до выхода.
    expect(SCREEN).not.toMatch(/prefetchTiles/);
    expect(SCREEN).toMatch(/const saveMap = useCallback/);
    // Проверяется наличие кнопки и того, что вес называется, — а не точная
    // строка. Прежняя привязка к `Сохранить карту · {mapPlan.mb} МБ` не
    // пустила правку, которая убирает с кнопки ноль: ноль там читался как
    // «бесплатно» перед закачкой на десятки мегабайт. С этапа 2 FCN кнопка
    // сохраняет полевой пакет целиком (карта + линия + точки + условия).
    expect(SCREEN).toContain('Сохранить полевой пакет');
    expect(SCREEN).toMatch(/mapPlan\.mb.*МБ/);
  });

  it('хранилище закрепляется тем же жестом', () => {
    expect(SCREEN).toMatch(/await requestPersistentStorage\(\)/);
  });

  it('отказ в закреплении и урезанные зумы названы человеку', () => {
    expect(SCREEN).toMatch(/Система может удалить карту при нехватке места/);
    expect(SCREEN).toMatch(/вблизи карта грубее/);
  });
});
