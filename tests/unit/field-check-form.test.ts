/**
 * Полевая проверка — форма и приём (владелец 21.08).
 *
 * Три черты, ради которых это делалось, и которые нельзя потерять:
 *  1. Проверка НЕ меняет данные — только очередь со статусом pending.
 *  2. Третье состояние: координата и точность необязательны, «не с места» —
 *     законное состояние; половина координаты не принимается.
 *  3. Офлайн не теряет улику: неотправленное лежит на диске и уходит само.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const report = readFileSync(join(process.cwd(), 'app/api/field-check/report/route.ts'), 'utf-8');
const nearby = readFileSync(join(process.cwd(), 'app/api/field-check/nearby/route.ts'), 'utf-8');
const client = readFileSync(join(process.cwd(), 'app/field-check/_FieldCheckClient.tsx'), 'utf-8');
const migration = readFileSync(join(process.cwd(), 'migrations/898_route_field_checks.sql'), 'utf-8');

describe('приём проверки — очередь, а не правка', () => {
  it('пишет только в route_field_checks', () => {
    expect(report).toContain('INSERT INTO route_field_checks');
    expect(report).not.toMatch(/UPDATE kamchatka_routes|UPDATE places/);
  });

  it('статус по умолчанию — pending, решает человек', () => {
    expect(migration).toMatch(/status[\s\S]{0,80}DEFAULT 'pending'/);
  });

  it('вход валидируется Zod и параметризован', () => {
    expect(report).toContain('BodySchema.parse');
    // Плейсхолдеров стало больше вместе с координатой объекта (миграция
    // 900); сторож держит не их число, а то, что значения не склеиваются
    // в строку запроса.
    expect(report).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8(, \$9, \$10, \$11)?\)/);
    expect(report).not.toMatch(/INSERT INTO route_field_checks[\s\S]{0,400}\$\{/);
  });

  it('половина координаты не принимается', () => {
    expect(report).toMatch(/hasLat !== hasLng/);
  });

  it('координата и точность допускают отсутствие', () => {
    expect(report).toMatch(/reported_lat: z\.number\(\)[\s\S]{0,60}\.nullable\(\)/);
    expect(report).toMatch(/accuracy_m: z\.number\(\)[\s\S]{0,80}\.nullable\(\)/);
    expect(migration).toMatch(/accuracy_m\s+INTEGER CHECK \(accuracy_m IS NULL/);
  });
});

describe('выборка рядом — только живые записи', () => {
  it('скрытые и слитые не показываются', () => {
    expect(nearby).toMatch(/p\.is_visible = true AND p\.merged_into_id IS NULL/);
    expect(nearby).toMatch(/r\.is_visible = true AND r\.merged_into_id IS NULL/);
  });

  it('незнание показывается словами, а не нулём', () => {
    expect(client).toContain("f.value ?? 'не знаем'");
  });
});

describe('офлайн не теряет улику', () => {
  it('очередь на диске и отправка при возврате связи', () => {
    // Очередь переехала в IndexedDB, когда к проверке добавились снимки:
    // в пятимегабайтный localStorage помещалось три фотографии, а выход в
    // поле — это десятки проверок.
    expect(client).toContain('listFieldChecks');
    expect(client).toMatch(/addEventListener\('online'/);
  });

  it('неотправленное видно человеку', () => {
    expect(client).toMatch(/Не отправлено: \{queueLen\}/);
  });
});

describe('PWA и фотографии', () => {
  const sw = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf-8');
  const photo = readFileSync(join(process.cwd(), 'app/api/field-check/photo/route.ts'), 'utf-8');
  const db = readFileSync(join(process.cwd(), 'lib/offline/db.ts'), 'utf-8');

  it('форма прекэшируется — её открывают там, где связи нет', () => {
    expect(sw).toContain("'/field-check'");
  });

  it('версия кэша поднята вместе с составом прекэша', () => {
    // Черта, а не номер: привязка к 'v27' ломалась при каждом следующем
    // подъёме версии, хотя правило — «состав прекэша сменился, значит имя
    // кэша обязано смениться тоже», и оно не про конкретную цифру.
    const m = /CACHE_NAME = 'kamchatour-v(\d+)'/.exec(sw);
    expect(m, 'имя кэша не найдено').not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(27);
    expect(sw).toContain('/field-check');
  });

  it('форма регистрирует service worker сама', () => {
    expect(client).toMatch(/serviceWorker\.register\('\/sw\.js'\)/);
  });

  it('снимок сжимается на телефоне, а не отправляется оригиналом', () => {
    expect(client).toContain('PHOTO_MAX_SIDE');
    expect(client).toMatch(/toDataURL\('image\/jpeg', PHOTO_QUALITY\)/);
  });

  it('очередь с фотографиями живёт в IndexedDB, не в localStorage', () => {
    expect(client).toContain('queueFieldCheck');
    expect(client).not.toContain('field_check_queue_v1');
    expect(db).toMatch(/fieldChecks/);
    // Число версии растёт с каждым новым хранилищем (v5 — заготовка выхода);
    // сторож держит инвариант, а не конкретную цифру.
    expect(db).toMatch(/DB_VERSION = \d+/);
    expect(db).toMatch(/if \(!db\.objectStoreNames\.contains\('fieldChecks'\)\)/);
  });

  it('снимок принимается отдельно и с потолком размера', () => {
    expect(photo).toContain('MAX_BYTES');
    expect(photo).toContain('INSERT INTO route_field_check_photos');
    expect(photo).not.toMatch(/UPDATE kamchatka_routes|UPDATE places/);
  });

  it('запись удаляется из очереди только после успеха', () => {
    expect(client).toMatch(/if \(!res\.ok\) break;[\s\S]{0,900}deleteFieldCheck\(item\.id\)/);
  });
});

describe('геолокация самой точки — не путать с местом проверяющего', () => {
  const migration900 = readFileSync(
    join(process.cwd(), 'migrations/900_field_check_object_coords.sql'), 'utf-8');

  it('координата объекта хранится отдельно от координаты проверяющего', () => {
    expect(migration900).toMatch(/object_lat\s+DECIMAL\(9,6\)/);
    expect(migration900).toMatch(/object_lng\s+DECIMAL\(9,6\)/);
    expect(report).toMatch(/object_lat, object_lng, object_source/);
  });

  it('у координаты объекта обязательно происхождение', () => {
    expect(report).toMatch(/hasObjLat && !data\.object_source/);
    expect(migration900).toMatch(/object_source IN \('my_fix', 'manual'\)/);
  });

  it('половина координаты не принимается ни на входе, ни в схеме', () => {
    expect(report).toMatch(/hasObjLat !== hasObjLng/);
    expect(migration900).toMatch(/\(object_lat IS NULL\) = \(object_lng IS NULL\)/);
  });

  it('«я стою на точке» берёт свежий фикс, а не старый', () => {
    expect(client).toMatch(/takeMyFix[\s\S]{0,900}maximumAge: 0/);
  });

  it('ручной ввод разбирает пару чисел и проверяет пределы', () => {
    expect(client).toContain('applyManual');
    expect(client).toMatch(/lat < -90 \|\| lat > 90 \|\| lng < -180 \|\| lng > 180/);
  });
});

describe('юзабилити поля: рука в перчатке, ветер, садящаяся батарея', () => {
  it('полевые цели крупные — объявленный порог тапа', () => {
    expect(client).toMatch(/const TAP = 56/);
    expect(client).toMatch(/minHeight: TAP/);
  });

  it('первый вопрос по записи один: сходится или нет', () => {
    expect(client).toContain('Сходится с тем, что видите?');
    expect(client).toContain('Да, всё сходится');
    expect(client).toContain('Нет, что-то не так');
  });

  it('подробности спрашиваются только у того, кто сказал «не так»', () => {
    expect(client).toMatch(/open && asking/);
    expect(client).toMatch(/problemFor === item\.id/);
  });

  it('без спутников экран не бесполезен — координаты вручную', () => {
    // Черта, а не подпись: слово на кнопке меняется при упрощении формы, а
    // возможность ввести координату руками терять нельзя — именно там, где
    // спутников нет, экран и нужен.
    expect(client).toContain('applyManualCenter');
    expect(client).toMatch(/manualCenter/);
  });

  it('видно, сколько сделано и сколько ждёт связи', () => {
    expect(client).toMatch(/Проверено \$\{checkedCount\} из \$\{items\.length\}/);
    expect(client).toMatch(/в очереди \$\{queueLen\}/);
  });

  it('проверенное помнится между заходами, а не только в сессии', () => {
    expect(client).toContain('field_check_done_v1');
    expect(client).toContain('rememberDone');
  });

  it('в длинном списке есть поиск и фильтр непроверенных', () => {
    expect(client).toContain('Найти по названию');
    expect(client).toMatch(/onlyPending/);
  });

  it('радиус выбирается, а не задан навсегда', () => {
    expect(client).toMatch(/\[5, 15, 40\]\.map/);
  });
});

describe('выход по маршруту и офлайн-заготовка', () => {
  const routes = readFileSync(join(process.cwd(), 'app/api/field-check/routes/route.ts'), 'utf-8');
  const db2 = readFileSync(join(process.cwd(), 'lib/offline/db.ts'), 'utf-8');

  it('маршрут ищется по имени среди живых записей', () => {
    expect(routes).toMatch(/r\.is_visible = true AND r\.merged_into_id IS NULL/);
    expect(routes).toMatch(/title ILIKE '%' \|\| \$1 \|\| '%'/);
  });

  it('счёт точек пути не считает соседей «рядом»', () => {
    expect(routes).toMatch(/link_kind, 'unknown'\) <> 'nearby'/);
  });

  it('радиус по маршруту считается от его точек, а не выдумывается', () => {
    expect(nearby).toContain('centerFromRoute');
    expect(nearby).toMatch(/Math\.max\(8, Math\.ceil\(span \+ 5\)\)/);
  });

  it('маршрут без координаты честно отвергается, а не ведёт вслепую', () => {
    expect(nearby).toMatch(/У маршрута нет координаты/);
  });

  it('район сохраняется на телефон и открывается без сети', () => {
    // Черта, а не номер. Привязка к конкретной версии базы ломается при
    // КАЖДОМ новом хранилище — за сутки это случилось трижды, и каждый раз
    // краснел не дефект, а собственный сторож. Правило же простое:
    // хранилище объявлено, и версия не ниже той, где оно появилось.
    expect(db2).toMatch(/fieldCheckAreas/);
    const m = /const DB_VERSION = (\d+)/.exec(db2);
    expect(m, 'версия базы не найдена').not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(5);
    expect(client).toContain('saveFieldCheckArea');
    expect(client).toContain('openSavedArea');
  });

  it('сохранённый выход виден на первом экране', () => {
    expect(client).toMatch(/Открыть выход: \{savedArea\.label\}/);
    expect(client).toContain('работает без интернета');
  });
});

/**
 * «1 точек пути» — мелочь, которая читается как небрежность ко всему
 * остальному: человек, увидевший кривое слово, не поверит и цифре рядом.
 */
describe('склонение числа путевых точек', () => {
  it('единственное, двойственное и множественное', async () => {
    const { waypointsPhrase } = await import('@/app/field-check/_FieldCheckClient');
    expect(waypointsPhrase(1)).toBe('1 точка пути');
    expect(waypointsPhrase(2)).toBe('2 точки пути');
    expect(waypointsPhrase(4)).toBe('4 точки пути');
    expect(waypointsPhrase(5)).toBe('5 точек пути');
    expect(waypointsPhrase(11)).toBe('11 точек пути');
    expect(waypointsPhrase(14)).toBe('14 точек пути');
    expect(waypointsPhrase(21)).toBe('21 точка пути');
    expect(waypointsPhrase(22)).toBe('22 точки пути');
    expect(waypointsPhrase(111)).toBe('111 точек пути');
  });
});

/**
 * Упрощение формы (владелец 21.08: «нужно проще»).
 *
 * Проверяется не красота, а два свойства: свёрнутая карточка не выгружает
 * базу на экран, и вопрос о координате задаётся только тому, кто сказал,
 * что точка не там.
 */
describe('форма проще', () => {
  it('свёрнутая карточка несёт одно обещание, а не все факты', async () => {
    const { headlineClaim } = await import('@/app/field-check/_FieldCheckClient');
    expect(headlineClaim({
      kind: 'route', subtitle: 'medium',
      facts: [{ label: 'дистанция', value: '12.10 км' }, { label: 'линия', value: 'есть (external)' }],
    })).toBe('обещаем 12,1 км');
    // У места отдельного обещания нет: тип уже стоит строкой выше, и
    // повторять его значит занимать строку ничем.
    expect(headlineClaim({ kind: 'place', subtitle: 'waterfall', facts: [] })).toBeNull();
  });

  it('число по-русски, без хвоста нулей из колонки NUMERIC', async () => {
    const { ruAmount } = await import('@/app/field-check/_FieldCheckClient');
    expect(ruAmount('12.10 км')).toBe('12,1 км');
    expect(ruAmount('45.00 км')).toBe('45 км');
    expect(ruAmount('1.90 км')).toBe('1,9 км');
    // Не число — отдаётся как есть, а не превращается в мусор.
    expect(ruAmount('не знаем')).toBe('не знаем');
  });

  it('код базы не показывается человеку: незнакомый ярлык молчит', async () => {
    const { subtitleWord } = await import('@/app/field-check/_FieldCheckClient');
    expect(subtitleWord('waterfall')).toBe('водопад');
    expect(subtitleWord('medium')).toBe('средне');
    expect(subtitleWord('lava_dome_xyz')).toBeNull();
    expect(subtitleWord(null)).toBeNull();
  });

  it('нечего обещать — строки нет, а не «не знаем»', async () => {
    const { headlineClaim } = await import('@/app/field-check/_FieldCheckClient');
    expect(headlineClaim({
      kind: 'route', subtitle: null, facts: [{ label: 'дистанция', value: null }],
    })).toBeNull();
    expect(headlineClaim({ kind: 'place', subtitle: null, facts: [] })).toBeNull();
  });

  it('координата объекта спрашивается только у вердикта «точка не там»', () => {
    expect(client).toMatch(/problem === 'coords_wrong' && \(/);
  });

  it('редкие настройки убраны под одну ссылку', () => {
    expect(client).toContain("Ещё: координаты вручную, радиус");
    expect(client).toMatch(/\{showMore && \(/);
  });
});
