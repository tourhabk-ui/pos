/**
 * Экран «На маршруте» обязан знать происхождение координаты цели.
 *
 * Повод (10.09-11.09): за два дня в поле нашлись пять неверных координат
 * (Голубые озёра, Овальное, Смотровая у Авачинского, Лежбище сивучей,
 * Озеро Котельное) — приложение вело человека к точному азимуту и
 * «~5 мин», посчитанным от неверной точки. Прибор не врал; врала точка,
 * а прибор об этом молчал.
 *
 * Правило 10.09 (§4 CLAUDE.md, «Объявленный исход без источника»): у
 * связки должны быть и производитель, и потребитель, и сторож, который
 * их держит вместе. Здесь:
 *   производитель — SELECT p.coord_source в /api/routes/[id];
 *   потребитель   — статус-строка экрана «На маршруте», которая проверяет
 *                    coordIsTrustworthy и предупреждает, если не 'surveyed';
 *   сторож        — этот файл.
 *
 * Без сторожа связка рвётся молча: кто-нибудь один раз перепишет SELECT
 * без coord_source (или уберёт ветку статус-строки при рефакторинге) — и
 * предупреждение исчезнет навсегда, а тишина будет выглядеть как «всё
 * подтверждено».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const API_ROUTE = read('app/api/routes/[id]/route.ts');
const FIELD_CLIENT = read('app/planning/_PlanningClient.tsx');

describe('/api/routes/[id] — coord_source доходит до ответа', () => {
  it('SELECT читает p.coord_source', () => {
    expect(API_ROUTE).toMatch(/p\.coord_source/);
  });

  it('waypoints[] отдают coordSource, а не молчат о нём', () => {
    expect(API_ROUTE).toMatch(/coordSource:\s*.*w\.coord_source/);
  });
});

describe('экран «На маршруте» — не полагается молча на неподтверждённую координату', () => {
  it('SavedWaypoint несёт coordSource (не молча теряет поле API)', () => {
    expect(FIELD_CLIENT).toMatch(/coordSource\?:\s*CoordSource/);
  });

  it('обе точки входа (живой fetch и превью) прокидывают coordSource из ответа', () => {
    const matches = FIELD_CLIENT.match(/coordSource:\s*\(w\.coordSource as CoordSource \| null\) \?\? undefined/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('статус-строка проверяет coordIsTrustworthy у цели и предупреждает явно', () => {
    expect(FIELD_CLIENT).toMatch(/coordIsTrustworthy\(targetCoordSource\)/);
    // Предупреждение называет источник (coordSourceLabel), а не абстрактное
    // «что-то не так» — честный ответ конкретнее общего.
    expect(FIELD_CLIENT).toMatch(/coordSourceLabel\(targetCoordSource\)/);
  });

  it('отсутствие coordSource (точка не из places) не считается подтверждением', () => {
    // `if (targetCoordSource && ...)` — а не truthy-проверка одного null:
    // undefined обязан пропускать проверку молча, а не читаться как «плохо»
    // и не как «хорошо». Ищем именно охранное условие перед вызовом.
    expect(FIELD_CLIENT).toMatch(/if \(targetCoordSource && !coordIsTrustworthy\(targetCoordSource\)\)/);
  });
});
