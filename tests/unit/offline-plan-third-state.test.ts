/**
 * Сторож: «карта не сохранена» обязана иметь ответ (07.09).
 *
 * ── Что было на экране владельца ───────────────────────────────────────────
 *
 * Экран «На маршруте», человек стоит на маршруте: строка «Карта не сохранена
 * — в поле не откроется» и НИ ОДНОЙ кнопки, которой это можно исправить.
 *
 * Причина лежала в коде и была того же рода, что мы чиним весь день:
 * `loadMapPlan` глотал отказ дважды — `if (!res.ok || ...) return;` и пустой
 * `catch` с комментарием «план — удобство, а не условие выхода». В
 * интерфейсе всё наоборот: блок сохранения рисуется ТОЛЬКО при `mapPlan`,
 * то есть без плана сохранить карту нечем. Отказ сервера превращался в
 * отсутствие действия, без единого слова.
 *
 * Платформа офлайн-first: карта, SOS и маршрут обязаны работать без сети
 * (CLAUDE.md, шапка). Уход в поле без карты — цена этого молчания.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf8');
// С 25.09 план считает общий модуль — его зовут и полевой экран, и карточка
// маршрута. Сторож идёт за кодом: исходы судятся там, где они рождаются.
const LIB = readFileSync(join(process.cwd(), 'lib/offline/route-map-save.ts'), 'utf8');

// Тело загрузчика плана — судим его, а не весь файл: «return» в тысяче
// других мест к этому вопросу отношения не имеет.
const loader = (() => {
  const at = SRC.indexOf('const loadMapPlan = useCallback');
  const end = SRC.indexOf('}, [regionPacks]);', at);
  return SRC.slice(at, end);
})();

const plan = (() => {
  const at = LIB.indexOf('export async function planRouteMap(');
  const end = LIB.indexOf('\n}\n', at);
  return LIB.slice(at, end);
})();

describe('отказ плана карты называется словами', () => {
  it('немого catch у запроса плана больше нет', () => {
    expect(loader.length, 'загрузчик плана исчез — сторож ослеп').toBeGreaterThan(0);
    expect(plan.length, 'planRouteMap исчез — сторож ослеп').toBeGreaterThan(0);
    expect(plan).not.toContain('план — удобство, а не условие выхода');
    const planCatch = plan.slice(plan.indexOf('offline-bundle`'));
    expect(planCatch).toMatch(/catch \(err\)/);
    expect(plan).toContain("console.error('[offline-bundle]");
    // Экран не глотает отказ модуля: причина уходит в mapPlanError.
    expect(loader).toMatch(/await planRouteMap\(routeId, regionPacks\)/);
    expect(loader).toMatch(/if \(!res\.ok\) \{ setMapPlanError\(res\.error\); return; \}/);
  });

  it('у каждого исхода свой ответ, а не общий «плана нет»', () => {
    // HTTP-отказ, пустой план и обрыв — разные вещи и стоят разного.
    expect(plan).toContain('Сервер не отдал план карты');
    expect(plan).toContain('нет линии или координат');
    expect(plan).toContain('проверьте связь и повторите');
  });

  it('офлайн — «не посчитать», а не «сохранять нечего»', () => {
    expect(plan).toContain('navigator.onLine === false');
    expect(plan).toContain('Нет связи');
  });

  it('успех гасит прежнюю причину', () => {
    // Иначе разовый отказ остался бы на экране навсегда.
    expect(loader).toContain('setMapPlanError(null)');
  });
});

describe('предупреждению есть чем ответить', () => {
  it('блок появляется и когда плана нет, но причина известна', () => {
    expect(SRC).toContain('(tileDl || savedMap || mapPlan || mapPlanError)');
  });

  it('рядом с причиной стоит «Повторить», а не немой null', () => {
    const branch = SRC.slice(SRC.indexOf(') : mapPlanError ? ('));
    expect(branch.slice(0, 1400)).toContain('Повторить');
    expect(branch.slice(0, 1400)).toContain('loadMapPlan');
  });
});
