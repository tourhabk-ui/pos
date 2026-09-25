/**
 * Сторож кнопки «Сохранить карту» на полевом экране: нажатие обязано что-то
 * сказать.
 *
 * ── Что случилось (15.09, снимок владельца) ───────────────────────────────
 *
 * «Кнопка скачать не работает». Кнопка при этом отрабатывала штатно — и
 * молчала. Молчаний было четыре, и все они на экране подготовки к выходу
 * читаются одинаково: «сохранилось».
 *
 *   1. `if (!mapPlan || !navigator.serviceWorker) return;` — немой выход;
 *   2. `if (!sw) return;` — немой выход;
 *   3. `catch { /* ignore *\/ }` — поломка превращалась в «ничего не
 *      случилось»;
 *   4. САМЫЙ частый: service worker на `CACHE_TILES` отвечает
 *      `TILES_UNAVAILABLE` — массовая закачка тайлов выключена решением
 *      владельца 28.08 (M0, «источник тайлов меняется»), ни одного тайла не
 *      качается ВООБЩЕ. Причина при этом уходила в `saveMapError`, который
 *      рисуется только внутри развёрнутого листа, в блоке «Карта офлайн», —
 *      а нажимали кнопку в НИЖНЕЙ ПОЛОСЕ действий, у которой своя строка
 *      отказа (`fieldBarError`) и в неё сохранение карты не писало никогда.
 *
 * Вверху каждого полевого экрана при этом висит «Карта не сохранена — в поле
 * не откроется». Человек читает предупреждение, жмёт единственную кнопку
 * рядом, не получает ни успеха, ни отказа — и уходит на маршрут, считая
 * вопрос закрытым.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Не текст сообщений, а отсутствие немых выходов: у каждой ветки отказа есть
 * слова, и полоса действий их показывает.
 *
 * С 24.09 (скрин владельца «Карта не сохраняеться») кнопка качает свои
 * пакеты карты — растровая закачка OSM остаётся выключенной (M0, 28.08), но
 * полевой экран её больше не зовёт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');
const SW  = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');
// С 25.09 закачку и её отказы ведёт общий модуль: его зовут полевой экран и
// карточка маршрута. Сторож идёт за кодом, а не за прежним адресом.
const LIB = readFileSync(join(ROOT, 'lib/offline/route-map-save.ts'), 'utf-8');
const ROUTE_CARD = readFileSync(join(ROOT, 'app/routes/[id]/_RouteDetailClient.tsx'), 'utf-8');

/** Тело saveRouteMap — общей закачки обеих кнопок. */
function libSaveBody(): string {
  const from = LIB.indexOf('export async function saveRouteMap(');
  expect(from, 'saveRouteMap исчез — сторож ослеп').toBeGreaterThan(-1);
  return LIB.slice(from, LIB.indexOf('\n}\n', from));
}

/** Тело saveMap — от объявления до закрывающего useCallback-хвоста. */
function saveMapBody(): string {
  const from = SRC.indexOf('const saveMap = useCallback(');
  expect(from, 'saveMap исчез из полевого экрана').toBeGreaterThan(-1);
  const end = SRC.indexOf('}, [mapPlan, assemblePack]);', from);
  expect(end, 'хвост saveMap не найден — сторож ослеп, поправить границы').toBeGreaterThan(from);
  return SRC.slice(from, end);
}

describe('у сохранения карты нет немых выходов', () => {
  const body = saveMapBody();

  it('каждый ранний выход что-то говорит', () => {
    // `return;` сразу после условия, без setSaveMapError перед ним, — это
    // ровно то нажатие «в никуда», с которого начался разбор.
    //
    // Из проверки исключён ОДИН возврат — фильтр чужих сообщений service
    // worker'а по regionId. Он не отказ, а маршрутизация: сообщение про
    // другой маршрут молча пропускают, и говорить тут человеку нечего.
    // Заносить его в список исключений честнее, чем ослабить регулярку до
    // бессмысленной.
    const ROUTING_GUARD = /\?\.regionId !== routeId\) return;/;
    const mute = body
      .split('\n')
      .filter(l => /\)\s*return;/.test(l) && !ROUTING_GUARD.test(l));
    expect(mute, `немой return в saveMap: ${mute.join(' | ')}`).toEqual([]);
  });

  it('нет плана карты — сказано, что плана нет', () => {
    expect(body).toMatch(/if \(!mapPlan\) \{[\s\S]*?setSaveMapError\(/);
  });

  it('отказ общей закачки доходит до экрана, а не глотается', () => {
    expect(body).toMatch(/const res = await saveRouteMap\(routeId, mapPlan, setTileDl\)/);
    expect(body).toMatch(/if \(!res\.ok\) \{\s*setSaveMapError\(res\.error\);/);
  });

  const lib = libSaveBody();

  it('нет service worker — сказано, что сохранять нечем', () => {
    expect(lib).toMatch(/!navigator\.serviceWorker\) \{\s*return \{ ok: false, error: '/);
  });

  it('service worker ещё не активен — сказано, а не проглочено', () => {
    expect(lib).toMatch(/if \(!reg\.active\) \{\s*return \{ ok: false, error: '/);
  });

  it('исключение не глушится пустым catch', () => {
    // Проверяется ВНЕШНИЙ catch — тот, что закрывает закачку пакетов.
    // Внутренний `catch { /* ignore */ }` у записи в localStorage законен и
    // остаётся: приватный режим отказывает в записи, а карта при этом уже
    // сохранена, и пугать этим человека нечем.
    expect(lib).toMatch(/await downloadPackFiles\([\s\S]*?\} catch \(err\)/);
    expect(lib).toMatch(/catch \(err\) \{[\s\S]*?console\.error\('\[field-pack\][\s\S]*?return \{ ok: false, error:/);
    // Прогресс обязан сняться: иначе кнопка навсегда останется «занята».
    // Снимает его экран — после ЛЮБОГО исхода общей закачки.
    expect(body.indexOf('setTileDl(null)')).toBeGreaterThan(body.indexOf('await saveRouteMap('));
    expect(body.indexOf('setTileDl(null)')).toBeLessThan(body.indexOf('if (!res.ok)'));
  });

  it('нет Cache Storage — сказано, что хранить негде', () => {
    expect(lib).toMatch(/if \(typeof caches === 'undefined'\) \{\s*return \{ ok: false, error: '/);
  });
});

describe('полоса действий показывает отказ сохранения карты', () => {
  it('во всех трёх местах, где полоса рисуется', () => {
    // Кнопку жмут в полосе, а причина уходила в блок развёрнутого листа —
    // другое место экрана, до которого ещё надо добраться.
    const wired = SRC.match(/error=\{fieldBarError \?\? saveMapError\}/g) ?? [];
    const bars  = SRC.match(/<FieldActionBar /g) ?? [];
    expect(bars.length, 'полосы действий исчезли с экрана').toBeGreaterThanOrEqual(3);
    expect(wired.length, 'полоса где-то осталась без отказа сохранения').toBe(bars.length);
  });

  it('у полосы вообще есть куда это показать', () => {
    const bar = readFileSync(join(ROOT, 'components/field/FieldActionBar.tsx'), 'utf-8');
    expect(bar).toMatch(/error\?: string \| null/);
    expect(bar).toMatch(/\{error && \(/);
  });
});

describe('ответ «закачка недоступна» доходит до человека', () => {
  it('service worker на CACHE_TILES по-прежнему отвечает отказом словами', () => {
    // Растровая массовая закачка OSM выключена (M0, 28.08) и остаётся
    // выключенной: её ещё зовут другие экраны, и им отказ должен быть назван.
    expect(SW).toMatch(/type: 'TILES_UNAVAILABLE'/);
    expect(SW).toMatch(/reason: 'Массовая закачка карты временно недоступна/);
  });
});

describe('полевой экран сохраняет СВОИ пакеты и называет каждую неудачу (24.09)', () => {
  // Скрин владельца 24.09 «Карта не сохраняеться»: кнопка слала CACHE_TILES,
  // service worker честно отвечал «недоступно» — и так было всегда, успеха
  // у кнопки не было ни одного. Теперь она качает свои пакеты.
  const body = saveMapBody();
  const lib = libSaveBody();

  it('не зовёт выключенную растровую закачку', () => {
    expect(body).not.toMatch(/CACHE_TILES/);
    expect(lib).not.toMatch(/CACHE_TILES/);
    expect(lib).toMatch(/await downloadPackFiles\(plan\.files/);
  });

  it('ноль сохранённых — отказ с первой причиной, а не запись «сохранено»', () => {
    expect(lib).toMatch(/if \(res\.saved === 0\) \{\s*return \{ ok: false, error: `Карта не сохранилась: \$\{res\.failed\[0\]\?\.why/);
    // Запись о сохранении идёт ПОСЛЕ проверки нуля — и в модуле, и на экране.
    expect(lib.indexOf('res.saved === 0')).toBeLessThan(lib.indexOf('localStorage.setItem(savedMapKey'));
    expect(body.indexOf('if (!res.ok)')).toBeLessThan(body.indexOf('setSavedMap(res.rec)'));
  });

  it('частичная закачка названа: сколько из скольких и что не легло', () => {
    expect(lib).toMatch(/Сохранено \$\{res\.saved\} из \$\{plan\.tiles\} файлов карты — не легли/);
    expect(body).toMatch(/setSaveMapError\(res\.warning\)/);
    expect(body).toMatch(/assemblePack\(routeId, res\.failed\.length, res\.persisted\)/);
  });

  it('место проверяется до закачки, а не после сотни мегабайт', () => {
    expect(lib.indexOf('navigator.storage?.estimate')).toBeGreaterThan(-1);
    expect(lib.indexOf('navigator.storage?.estimate')).toBeLessThan(lib.indexOf('await downloadPackFiles'));
    expect(lib).toMatch(/Не хватит места: карта ~\$\{plan\.mb\} МБ/);
  });
});

describe('карточка маршрута сохраняет тем же правилом (25.09)', () => {
  // «Скачать для похода» слала CACHE_TILES после выключения растровой
  // закачки (28.08) и не сохранила ни разу, а без service worker'а сразу
  // рисовала «Готово к офлайн», не положив ни байта.
  it('зовёт общий план и общую закачку, а не выключенную растровую', () => {
    expect(ROUTE_CARD).not.toMatch(/CACHE_TILES/);
    expect(ROUTE_CARD).toMatch(/await planRouteMap\(id, regionPacks\)/);
    expect(ROUTE_CARD).toMatch(/await saveRouteMap\(id, planned\.plan, setDlProgress\)/);
  });

  it('«готово» ставится только после удачной закачки без недокачанного', () => {
    const at = ROUTE_CARD.indexOf('const downloadOfflineBundle = useCallback(');
    const fn = ROUTE_CARD.slice(at, ROUTE_CARD.indexOf('}, [id, dlState, regionPacks]);', at));
    const dones = fn.match(/setDlState\('done'\)/g) ?? [];
    expect(dones.length, 'второй путь к «готово» в обход проверок').toBe(1);
    // Обе проверки обязаны СУЩЕСТВОВАТЬ: сравнение позиций с -1 прошло бы
    // и без них (мутация 25.09 — снятая проверка недокачанного не краснела).
    expect(fn).toMatch(/if \(!saved\.ok\) \{ setDlState\('error'\)/);
    expect(fn).toMatch(/if \(saved\.warning\) \{ setDlState\('error'\)/);
    expect(fn.indexOf("setDlState('done')")).toBeGreaterThan(fn.indexOf('if (!saved.ok)'));
    expect(fn.indexOf("setDlState('done')")).toBeGreaterThan(fn.indexOf('if (saved.warning)'));
  });

  it('причина отказа видна под кнопкой словами', () => {
    expect(ROUTE_CARD).toMatch(/setDlNote\(planned\.error\)/);
    expect(ROUTE_CARD).toMatch(/setDlNote\(saved\.error\)/);
    const shown = ROUTE_CARD.match(/\{dlNote && \(/g) ?? [];
    const buttons = ROUTE_CARD.match(/onClick=\{downloadOfflineBundle\}/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    expect(shown.length, 'у какой-то кнопки нет строки причины').toBe(buttons.length);
  });
});
