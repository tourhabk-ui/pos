/**
 * Сторож: у активного дня плана есть род — с оператором, сам или на выбор.
 *
 * Владелец 25.09: «можно же самому подобрать план — сегодня сам, завтра с
 * одним оператором, потом отдых, и так на всё время на Камчатке». Движок так
 * поездку и собирал, но человек этого не видел: активный день выглядел
 * одинаково, был ли за ним тур оператора, место для самостоятельного выхода
 * или ничего.
 *
 * Держит связку целиком (§10.09): правило рода — производитель в движке на
 * КАЖДОМ активном дне — потребитель в карточке дня и в PDF — подпись на
 * главной, которая обещает ровно это.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activityMode } from '@/lib/planner/day-mode';
import { planItemStatus, PLAN_ITEM_STATUS } from '@/lib/planner/item-status';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const ENGINE = read('lib/planner/engine.ts');
const CLIENT = read('app/planner/_PlannerClient.tsx');
const HOME = read('app/_home/_HomeV8Client.tsx');

describe('правило рода', () => {
  it('тур оператора — «с оператором», место или маршрут — «сам»', () => {
    expect(activityMode({ realTour: { tourId: '27' }, route: null })).toBe('operator');
    expect(activityMode({ realTour: null, route: { id: 'r1' } })).toBe('self');
    // Тур важнее маршрута: движок берёт его первым.
    expect(activityMode({ realTour: { tourId: '27' }, route: { id: 'r1' } })).toBe('operator');
  });

  it('ни тура, ни маршрута — «на выбор», а не «сам»', () => {
    // «Сам» пообещал бы маршрут, которого в базе нет (§4.0).
    expect(activityMode({ realTour: null, route: null })).toBe('open');
    // На карточке такой день — «идея», а не «сам» (метка пункта, #3399 п. 7).
    expect(planItemStatus({ type: 'activity', activityMode: 'open' })).toBe('idea');
    expect(PLAN_ITEM_STATUS.idea.label).toBe('Идея · тура нет');
  });
});

describe('движок ставит род на каждый активный день', () => {
  it('сколько активных дней собирается — столько и родов', () => {
    // Вычитаем определения типов: ищем только сборку дней.
    const pushes = (ENGINE.match(/type: 'activity', zone:/g) ?? []).length;
    const modes = (ENGINE.match(/activityMode: (activityMode\(\{ realTour, route \}\)|'(operator|self|open)')/g) ?? []).length;
    expect(pushes).toBeGreaterThan(0);
    expect(modes, 'активный день без рода — метка пропадёт молча').toBe(pushes);
  });

  it('род выводится из того, что поставлено на день, а не из интереса', () => {
    expect(ENGINE).toContain('activityMode: activityMode({ realTour, route })');
  });
});

describe('потребители', () => {
  // С 15.11 род дня входит в метку пункта (lib/planner/item-status): её
  // правило и рендер держит plan-item-status.test.tsx.
  it('карточка дня и PDF подписывают день меткой пункта', () => {
    expect(CLIENT).toContain('PlanItemBadge day={day}');
    expect(CLIENT).toContain('PLAN_ITEM_STATUS[st].label');
  });

  it('вход на главной обещает ровно то, что собирает движок', () => {
    expect(HOME).toMatch(/<b>Своя поездка<\/b><span>сам, тур, отдых<\/span>/);
    // «отдых» держит движок: дни отдыха — отдельный тип дня.
    expect(ENGINE).toMatch(/type: 'rest'/);
  });
});
