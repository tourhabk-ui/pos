/**
 * Карточка места → «На маршруте» пешком (баг 30.08: «маршрут есть, кнопки
 * перехода к месту нет»). NavigateTo довозит машиной до начала тропы — дальше
 * начинается то, что не делают чужие навигаторы (см. её же комментарий).
 * Раньше кнопки в это «дальше» с карточки места не было вовсе.
 *
 * Деплинк переиспользует то же поле поиска цели, что заполнил бы человек
 * сам (?q=) — не отдельная ветка кода, поэтому идёт по тем же
 * путям/группировке/ошибкам, что и ручной ввод. Тот же приём, что у
 * deep-link'а «Сообщить о наблюдении» (obs=1, владелец 29.08).
 *
 * auto=1 (владелец 30.08: «сразу на маршруте от места, где находится
 * пользователь») доводит цель и старт до автовыбора — первое совпадение
 * поиска и живой GPS, без двух лишних тапов. Способ передвижения и выбор
 * пути между несколькими вариантами остаются за человеком: это решение
 * влияет на безопасность, автомат его не принимает.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const PLACE = read('app/places/[id]/_PlaceDetailClient.tsx');
const TRAIL = read('app/planning/_PlanningClient.tsx');

describe('карточка места несёт деплинк на пеший путь', () => {
  it('ссылка ведёт на /planning?mode=trail&q=<имя места>&auto=1', () => {
    expect(PLACE).toContain('/planning?mode=trail&q=${encodeURIComponent(place.name)}&auto=1');
  });

  it('живёт рядом с NavigateTo (car) — тем же разделом карточки', () => {
    const navAt = PLACE.indexOf('<NavigateTo to={{ lat: place.lat, lng: place.lng, name: place.name }} mode="car" />');
    const linkAt = PLACE.indexOf('mode=trail&q=');
    expect(navAt).toBeGreaterThan(0);
    expect(linkAt).toBeGreaterThan(navAt);
    expect(linkAt - navAt).toBeLessThan(900);
  });
});

describe('OnTrailTab читает ?q= и предзаполняет тот же поиск, что и ручной ввод', () => {
  it('эффект берёт q из URL и зовёт setModalQuery — не заводит свою ветку', () => {
    const stateAt = TRAIL.indexOf("const [modalQuery, setModalQuery] = useState('')");
    expect(stateAt).toBeGreaterThan(0);
    const after = TRAIL.slice(stateAt, stateAt + 1200);
    expect(after).toMatch(/get\(['"]q['"]\)/);
    expect(after).toContain('setModalQuery(q.trim())');
  });

  it('auto=1 взводит одноразовый ref, а не state', () => {
    const stateAt = TRAIL.indexOf("const [modalQuery, setModalQuery] = useState('')");
    const after = TRAIL.slice(stateAt, stateAt + 1300);
    expect(after).toContain("useRef(false)");
    expect(after).toMatch(/get\(['"]auto['"]\)\s*===\s*['"]1['"]/);
    expect(after).toContain('cameFromPlaceRef.current = true');
  });
});

describe('auto=1 доводит цель и старт до автовыбора', () => {
  it('автовыбор цели переиспользует ту же группировку, что и карточки поиска', () => {
    const at = TRAIL.indexOf('Автовыбор цели');
    expect(at).toBeGreaterThan(0);
    const block = TRAIL.slice(at, at + 500);
    expect(block).toContain('groupRoutesByDestination(searchRoutes, modalQuery.trim())');
    expect(block).toContain('setSelectedDestination(destinations[0])');
    // Одноразовый: без этого автовыбор бы боролся с ручным выбором человека
    // при каждом новом searchRoutes.
    expect(block).toContain('autoDestConsumedRef.current = true');
  });

  it('автовыбор старта берёт текущую позицию из уже идущего GPS — не новый опрос', () => {
    const at = TRAIL.indexOf('Автовыбор старта');
    expect(at).toBeGreaterThan(0);
    const block = TRAIL.slice(at, at + 500);
    expect(block).toMatch(/kind:\s*['"]current['"]/);
    expect(block).toContain('coords.lat');
    expect(block).toContain('coords.lng');
    expect(block).toContain('autoOriginConsumedRef.current = true');
  });

  it('оба автовыбора стоят ПОСЛЕ объявления selectedDestination/selectedOrigin', () => {
    // TDZ-регрессия: эффект, ссылающийся на setState раньше её useState,
    // работает только благодаря отложенному вызову колбэка — читать такой
    // порядок в другой раз означает гадать, а не знать.
    const destStateAt = TRAIL.indexOf('const [selectedDestination, setSelectedDestination] = useState');
    const originStateAt = TRAIL.indexOf('const [selectedOrigin, setSelectedOrigin] = useState');
    const autoDestEffectAt = TRAIL.indexOf('Автовыбор цели');
    const autoOriginEffectAt = TRAIL.indexOf('Автовыбор старта');
    expect(destStateAt).toBeGreaterThan(0);
    expect(originStateAt).toBeGreaterThan(0);
    expect(autoDestEffectAt).toBeGreaterThan(destStateAt);
    expect(autoOriginEffectAt).toBeGreaterThan(originStateAt);
  });
});
