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
import { activityMode, ACTIVITY_MODE_LABEL } from '@/lib/planner/day-mode';

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
    expect(ACTIVITY_MODE_LABEL.open.label).toBe('На выбор');
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
  it('карточка дня рисует метку только у активного дня и только из поля движка', () => {
    expect(CLIENT).toContain("day.type === 'activity' && day.activityMode ? day.activityMode : null");
    expect(CLIENT).toContain('ACTIVITY_MODE_LABEL[mode].label');
  });

  it('PDF подписывает активный день родом', () => {
    expect(CLIENT).toContain('ACTIVITY_MODE_LABEL[d.activityMode].label');
  });

  it('вход на главной обещает ровно то, что собирает движок', () => {
    expect(HOME).toMatch(/<b>Своя поездка<\/b><span>сам, тур, отдых<\/span>/);
    // «отдых» держит движок: дни отдыха — отдельный тип дня.
    expect(ENGINE).toMatch(/type: 'rest'/);
  });
});
