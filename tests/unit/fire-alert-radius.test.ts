/**
 * Ассоциация пожарного алерта с точкой/маршрутом — радиус, а не зона (#861).
 *
 * Проверенный по коду дефект: `updateRealTimeStatus()` вешал любой алерт на
 * ВСЕ точки/маршруты зоны (northern/eastern/avachinsky, ~сотни км) через
 * `ark.zone = ANY(ea.affected_zones)`. Для пожара это неверно вдвойне:
 * `wildfire-firms.ts` пишет точные координаты кластера в `external_alerts.lat/
 * lng` (migration 687), а `agent_route_knowledge` (view из places +
 * kamchatka_routes, migration 711) отдаёт lat/lng для каждой точки/маршрута.
 * Одиночная термоточка (severity 0, возможно вулканическая термаль) зажигала
 * карточки маршрутов в 300 км от неё — предупреждение, которое видно всегда,
 * переставало быть предупреждением.
 *
 * Тест не гоняет SQL против живой БД (юнит-тесты в этом репо без live
 * Postgres — see vitest.config.ts), а проверяет исходник по конвенции
 * road-status-offline.test.ts: читает файл как текст, сверяет инварианты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const RAW = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8');
const CODE = RAW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('пожарный алерт — радиус вместо зоны', () => {
  it('fire_danger с координатами обеих сторон матчится по расстоянию (haversine), не по зоне', () => {
    expect(CODE, 'нет ветки fire_danger').toMatch(/alert_type\s*=\s*'fire_danger'/);
    expect(CODE, 'нет проверки координат события').toMatch(/ea\.lat IS NOT NULL AND ea\.lng IS NOT NULL/);
    expect(CODE, 'нет проверки координат точки').toMatch(/ark\.lat IS NOT NULL AND ark\.lng IS NOT NULL/);
    expect(CODE, 'нет формулы расстояния (haversine)').toMatch(/asin\(sqrt\(/);
    expect(CODE, 'нет земного радиуса 6371').toMatch(/6371/);
  });

  it('порог радиуса задан числом и уже привычной 300-км зоны', () => {
    const m = /\)\)\s*<=\s*(\d+)/.exec(CODE);
    expect(m, 'не найден порог сравнения с рассчитанным расстоянием').toBeTruthy();
    const radiusKm = Number(m![1]);
    expect(radiusKm).toBeGreaterThan(0);
    expect(radiusKm, 'радиус не должен спасать старую зональную ширину в сотни км').toBeLessThan(300);
  });

  it('событие или точка без обеих координат честно падают в зонный фолбэк', () => {
    // Фолбэк обязан быть примененим именно когда fire_danger-ветка условий не
    // выполняется целиком (NOT (...)) — а не отдельным самостоятельным ИЛИ,
    // который совпадал бы даже когда fire_danger с координатами уже дал матч.
    expect(CODE).toMatch(/NOT\s*\(\s*ea\.alert_type\s*=\s*'fire_danger'/);
    expect(CODE).toMatch(/ea\.affected_zones IS NULL/);
    expect(CODE).toMatch(/ark\.zone = ANY\(ea\.affected_zones\)/);
  });

  it('формула расстояния и зонный фолбэк объявлены один раз, а не трижды', () => {
    const distanceHits = CODE.match(/asin\(sqrt\(/g) ?? [];
    expect(distanceHits.length, 'формула расстояния продублирована — риск разъехаться, как в #897').toBe(1);

    const zoneHits = CODE.match(/ark\.zone = ANY\(ea\.affected_zones\)/g) ?? [];
    expect(zoneHits.length, 'зонный фолбэк продублирован').toBe(1);
  });

  it('каждая точка получает свежий active_alerts/severity даже без единого совпадения', () => {
    // LEFT JOIN на external_alerts внутри CTE — обязателен: INNER JOIN убрал бы
    // из агрегата точки без активных алертов, и их active_alerts не очистился
    // бы этим прогоном (осталось бы вчерашнее значение).
    expect(CODE, 'нет CTE агрегации по каждой точке').toMatch(/WITH matched AS/);
    expect(CODE, 'LEFT JOIN на external_alerts обязателен для очистки прежних алертов')
      .toMatch(/LEFT JOIN external_alerts ea/);
    expect(CODE).toMatch(/GROUP BY lrs_id/);
  });

  it('порог красного статуса (severity >= 2) не тронут рефакторингом', () => {
    expect(CODE).toMatch(/agg\.max_severity\s*>=\s*2\s+THEN\s+'red'/);
  });

  it('вместимость (capacity_per_day) по-прежнему определяет yellow/red', () => {
    expect(CODE).toMatch(/capacity_per_day/);
    expect(CODE).toMatch(/THEN 'yellow'/);
  });
});
