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
