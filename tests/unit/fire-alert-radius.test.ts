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
import { ROAD_ALERT_RADIUS_KM } from '@/lib/safety/alert-anchor';

/**
 * 27.09: предикат сопоставления алерта с местом ПЕРЕЕХАЛ из крон-роута в
 * `lib/services/safety/alert-place-scope.ts`. Пока он жил внутри роута,
 * проверить его можно было только вместе с походами за сводками, и его не
 * проверял никто — так дожили до прода пепел Шивелуча на Ключевском и
 * «Вилючинский перевал» за 500 км.
 *
 * Сторож идёт за правилом: инварианты те же (пожар судится расстоянием,
 * формула объявлена один раз), адрес другой. Роут проверяется отдельно — он
 * обязан ЗВАТЬ вынесенное правило, а не держать свою копию.
 */
const strip = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');
/**
 * ДВА адреса, а не один: 27.09 предикат сопоставления алерта с местом уехал
 * в свой модуль, а раскладка статусов (CTE, пороги severity, вместимость)
 * осталась в крон-роуте. Проверять их одним текстом значило бы искать
 * пороги статуса там, где их нет.
 */
const SCOPE = strip(readFileSync(join(process.cwd(), 'lib/services/safety/alert-place-scope.ts'), 'utf-8'));
const RAW = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8');
const CODE = strip(RAW);

describe('пожарный алерт — радиус вместо зоны', () => {
  it('fire_danger с координатами обеих сторон матчится по расстоянию (haversine), не по зоне', () => {
    // 15.09: радиусных родов стало два — к пожару добавилось ограничение
    // проезда (владелец: «30 км от вилючинского вулкана достаточно»).
    // Требование прежнее: пожар судится расстоянием, а не зоной.
    expect(SCOPE, 'нет ветки fire_danger').toMatch(/alert_type IN \([^)]*'fire_danger'[^)]*\)/);
    expect(SCOPE, 'нет проверки координат события').toMatch(/ea\.lat IS NOT NULL AND ea\.lng IS NOT NULL/);
    expect(SCOPE, 'нет проверки координат точки').toMatch(/ark\.lat IS NOT NULL AND ark\.lng IS NOT NULL/);
    expect(SCOPE, 'нет формулы расстояния (haversine)').toMatch(/asin\(sqrt\(/);
    expect(SCOPE, 'нет земного радиуса 6371').toMatch(/6371/);
  });

  it('каждый порог радиуса уже привычной 300-км зоны', () => {
    // Порог теперь не один: CASE по роду события. Проверяются ВСЕ — иначе
    // второй род мог бы тихо получить зональную ширину обратно.
    // Формула расстояния сведена в `distanceKmSql` (27.09), поэтому перед
    // `<=` в тексте запроса стоит её вызов, а не хвост `))`. Ищем сравнение
    // после любого из двух видов — смысл проверки прежний: КАЖДЫЙ порог уже
    // зональной ширины.
    const cmp = /<=\s*CASE ea\.alert_type([\s\S]{0,200}?)END/.exec(SCOPE)
      ?? /\)\)\s*<=\s*([\s\S]{0,200}?)END/.exec(SCOPE)
      ?? /<=\s*\$\{(CORRIDOR_VOLCANO_KM)\}/.exec(SCOPE);
    expect(cmp, 'не найден порог сравнения с рассчитанным расстоянием').toBeTruthy();

    const literals = (cmp![1].match(/\d+/g) ?? []).map(Number);
    expect(literals.length, 'в сравнении нет ни одного числового порога').toBeGreaterThan(0);
    for (const km of literals) {
      expect(km).toBeGreaterThan(0);
      expect(km, 'радиус не должен спасать старую зональную ширину в сотни км').toBeLessThan(300);
    }

    // Радиус дорожных приходит константой — в тексте запроса его числа нет,
    // и проверить его можно только у источника.
    expect(ROAD_ALERT_RADIUS_KM).toBeGreaterThan(0);
    expect(ROAD_ALERT_RADIUS_KM).toBeLessThan(300);
  });

  it('событие или точка без обеих координат честно падают в зонный фолбэк', () => {
    // Фолбэк обязан быть примененим именно когда fire_danger-ветка условий не
    // выполняется целиком (NOT (...)) — а не отдельным самостоятельным ИЛИ,
    // который совпадал бы даже когда fire_danger с координатами уже дал матч.
    // Фолбэк отрицает ТУ ЖЕ строку условия, что включает радиус
    // (GEO_SCOPED_SQL подставляется в обе ветки). Раньше условие было
    // выписано дважды — вторая копия могла разъехаться с первой молча.
    expect(SCOPE).toMatch(/NOT\s*\(\$\{GEO_SCOPED_SQL\}\)/);
    expect(SCOPE.match(/const GEO_SCOPED_SQL/g)?.length, 'условие радиуса объявлено не один раз').toBe(1);
    // С 17.09 пустые зоны — «никого», а не «весь край»: ветки IS NULL / = '{}'
    // в фолбэке нет (сторож — alert-zone-unknown.test.ts), остаётся зонное
    // совпадение.
    expect(SCOPE).toMatch(/AND ark\.zone = ANY\(ea\.affected_zones\)/);
  });

  it('формула расстояния и зонный фолбэк объявлены один раз, а не трижды', () => {
    const distanceHits = SCOPE.match(/asin\(sqrt\(/g) ?? [];
    expect(distanceHits.length, 'формула расстояния продублирована — риск разъехаться, как в #897').toBe(1);

    const zoneHits = SCOPE.match(/ark\.zone = ANY\(ea\.affected_zones\)/g) ?? [];
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

describe('правило вынесено, а не продублировано (27.09)', () => {
  it('крон-роут зовёт модуль скоупа', () => {
    expect(RAW).toContain("from '@/lib/services/safety/alert-place-scope'");
    expect(RAW).toMatch(/AND \(\$\{ALERT_MATCH_SQL\}\)/);
  });

  it('в роуте не осталось своей формулы расстояния', () => {
    // Вторая копия разошлась бы с первой при следующей правке радиуса.
    expect(CODE, 'в роуте снова своя формула расстояния').not.toMatch(/asin\(sqrt\(|6371 \* acos/);
  });
});
