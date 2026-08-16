/**
 * Упавший запрос карточки маршрута не притворяется пустыми данными.
 *
 * До 16.08 три запроса в `/api/routes/[id]` заканчивались
 * `.catch(() => ({ rows: [] }))`. Любая ошибка — упавший JOIN, разъехавшаяся
 * колонка, недоступная таблица — превращалась в правдоподобную пустоту, и
 * снаружи «у маршрута нет точек» было неотличимо от «запрос к точкам упал».
 *
 * Смоук увидел у настоящего маршрута «0 точек с координатами» и не смог
 * сказать, дефект это данных или поломка. Диагностика невозможна там, где
 * отказ выглядит как факт.
 *
 * Три запроса значат разное, и строгость у них разная:
 *
 *   - ТОЧКИ — хребет маршрута. Их отказ не переживается: отдать 200 с пустым
 *     хребтом значит соврать о маршруте, а по такому ответу человек идёт в
 *     поле. Пусть карточка честно не откроется.
 *   - ЖИВОЙ СТАТУС — переживается, но помечается. Пустой список ограничений
 *     читается как «ограничений нет», то есть как разрешение идти; это
 *     запрещено отдельно (§0.3: «нет данных» ≠ «спокойно»).
 *   - ОТЗЫВЫ — переживаются молча для пользователя, но не для лога: пустые
 *     отзывы не лгут о маршруте и не влияют на решение идти.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const DETAIL = read('app/api/routes/[id]/route.ts');
const DIAG = read('app/api/cron/catalog-diag/route.ts');

/** Код без комментариев: в комментариях прежний глушитель описан намеренно. */
const DETAIL_CODE = DETAIL
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*\*.*$/gm, '');

describe('молчаливых глушителей в карточке маршрута нет', () => {
  it('пустой catch, возвращающий rows: [], исчез', () => {
    // В комментариях прежний глушитель описан намеренно — запрещён он в коде.
    expect(DETAIL_CODE).not.toMatch(/catch\(\(\) => \(\{ rows: \[\] \}\)\)/);
  });

  it('отказ точек не глушится, а называется и бросается дальше', () => {
    const q = DETAIL.slice(
      DETAIL.indexOf('const waypointsResult = await query('),
      DETAIL.indexOf('const operationalResult'),
    );
    // Своё имя нужно для счётчика: строгость обязана быть наблюдаемой,
    // иначе тихо превратится в мор страниц, не связанный с этим решением.
    expect(q).toMatch(/logQueryFailure\('waypoints_failure'/);
    expect(q).toMatch(/throw err/);
    // Возврата пустых строк по-прежнему нет — карточка не открывается.
    expect(q).not.toMatch(/return \{ rows: \[\] \}/);
  });

  it('у отзывов и статуса отказ уходит в лог', () => {
    expect(DETAIL).toMatch(/logQueryFailure\('reviews'/);
    expect(DETAIL).toMatch(/logQueryFailure\('operational_alerts'/);
  });
});

describe('лог содержит то, чем чинят', () => {
  it('SQLSTATE, деталь, подсказка, позиция и релиз', () => {
    const fn = DETAIL.slice(DETAIL.indexOf('function logQueryFailure'));
    expect(fn).toMatch(/sqlstate: e\?\.code/);
    expect(fn).toMatch(/detail: e\?\.detail/);
    expect(fn).toMatch(/hint: e\?\.hint/);
    expect(fn).toMatch(/position: e\?\.position/);
    expect(fn).toMatch(/release: process\.env\.RELEASE_SHA/);
  });

  it('общий отказ карточки тоже логируется, а не только в dev-ответе', () => {
    // Раньше причина уходила в ответ и только при NODE_ENV=development —
    // то есть в проде не сохранялась нигде.
    expect(DETAIL).toMatch(/logQueryFailure\('route_detail', error, id\)/);
  });

  it('наружу причина не утекает', () => {
    // Публичный текст остаётся нейтральным; подробности только в логе.
    expect(DETAIL).toMatch(/error: 'Ошибка загрузки маршрута'/);
    expect(DETAIL).not.toMatch(/error: `[^`]*sqlstate/);
  });
});

describe('недоступный живой статус не выглядит спокойствием', () => {
  it('отказ помечается флагом в ответе', () => {
    expect(DETAIL).toMatch(/operationalStatusUnavailable: operationalUnavailable/);
  });

  it('флаг взводится именно в ветке отказа', () => {
    const branch = DETAIL.slice(
      DETAIL.indexOf("logQueryFailure('operational_alerts'"),
      DETAIL.indexOf('// Отзывы о маршруте'),
    );
    expect(branch).toMatch(/operationalUnavailable = true/);
  });
});

describe('диагностика видит ветку карточки, а не только каталог', () => {
  it('тот же JOIN точек проверяется отдельно', () => {
    expect(DIAG).toMatch(/точки маршрута \(тот же JOIN, что в карточке\)/);
    expect(DIAG).toMatch(/JOIN places p ON p\.id = rw\.place_id/);
  });

  it('есть счётчик точек с координатами — данные отделяются от поломки', () => {
    // Если запрос жив, а координат нет, это дефект ДАННЫХ, и ноль здесь
    // значит совсем не то, что упавший запрос.
    expect(DIAG).toMatch(/сколько точек маршрутов имеют координаты/);
    expect(DIAG).toMatch(/p\.lat IS NOT NULL AND p\.lng IS NOT NULL/);
  });

  it('диагностика сама предлагает кандидатов в фикстуру', () => {
    // Замкнутый круг «фикстуру не задать, пока не увидишь прогон» решается
    // здесь: id берутся из БД до мержа, и красного в истории не возникает.
    expect(DIAG).toMatch(/кандидаты в фикстуру смоука/);
    // Критерии, которых смоук по HTTP не видит.
    expect(DIAG).toMatch(/p\.merged_into_id IS NULL/);
    expect(DIAG).toMatch(/kr\.is_visible = TRUE/);
    expect(DIAG).toMatch(/HAVING COUNT\(\*\) >= 2/);
    // id в пространстве, которое понимает /api/routes/[id].
    expect(DIAG).toMatch(/COALESCE\(kr\.ark_id, kr\.id\)::text AS id/);
    // Синтетика уходит вниз: такая фикстура может смениться пересборкой.
    expect(DIAG).toMatch(/waypoints_synthetic'\) ASC/);
    expect(DIAG).toMatch(/candidates: res\.rows/);
  });

  it('ветка карточки выполняется даже если каталог упал', () => {
    // Список каталога обрывается на первом падении — там это верно. Но
    // карточка не «шаг сложнее», а другая ветка: обрывать её по чужому
    // падению значит повторить слепое пятно 16.08.
    expect(DIAG).toMatch(/const DETAIL_STEPS/);
    const loop = DIAG.slice(DIAG.indexOf('for (const step of DETAIL_STEPS)'));
    expect(loop.slice(0, 700)).not.toMatch(/\bbreak\b/);
  });
});
