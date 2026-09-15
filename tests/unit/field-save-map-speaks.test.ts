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
 * слова, и полоса действий их показывает. Сторож НЕ требует, чтобы карта
 * качалась: закачка выключена владельцем, и включать её обратно — отдельное
 * решение. Требуется только, чтобы отказ был назван.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');
const SW  = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');

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

  it('нет service worker — сказано, что сохранять нечем', () => {
    expect(body).toMatch(/if \(!navigator\.serviceWorker\) \{[\s\S]*?setSaveMapError\(/);
  });

  it('service worker ещё не активен — сказано, а не проглочено', () => {
    expect(body).toMatch(/if \(!sw\) \{[\s\S]*?setSaveMapError\(/);
  });

  it('исключение не глушится пустым catch', () => {
    // Проверяется ВНЕШНИЙ catch — тот, что закрывает отправку сообщения
    // service worker'у. Внутренний `catch { /* ignore */ }` у записи в
    // localStorage законен и остаётся: приватный режим отказывает в записи,
    // а пакет при этом уже сохранён, и пугать этим человека нечем.
    expect(body).toMatch(/sw\.postMessage\(\{ type: 'CACHE_TILES'[\s\S]{0,80}\}\);\s*\} catch \(err\)/);
    expect(body).toMatch(/console\.error\('\[field-pack\]/);
    // Прогресс обязан сняться: иначе кнопка навсегда останется «занята».
    expect(body).toMatch(/catch \(err\)[\s\S]*?setTileDl\(null\)/);
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
  it('service worker отвечает именно так, а не молчит', () => {
    // Пока это так, кнопка не может добиться успеха НИ РАЗУ — и тем важнее,
    // чтобы она говорила. Включать закачку обратно — решение владельца
    // (M0, 28.08), сторож на него не покушается.
    expect(SW).toMatch(/type: 'TILES_UNAVAILABLE'/);
    expect(SW).toMatch(/reason: 'Массовая закачка карты временно недоступна/);
  });

  it('экран разбирает этот ответ и кладёт причину в отказ', () => {
    const body = saveMapBody();
    expect(body).toMatch(/TILES_UNAVAILABLE/);
    expect(body).toMatch(/setSaveMapError\(m\.reason/);
  });

  it('и снимает индикатор прогресса, а не оставляет кнопку занятой', () => {
    const body = saveMapBody();
    const branch = body.slice(body.indexOf('TILES_UNAVAILABLE'));
    expect(branch.slice(0, 400)).toMatch(/setTileDl\(null\)/);
  });
});
