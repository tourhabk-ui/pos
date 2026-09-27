/**
 * Сторож: скидку назначает тот, кто продаёт, и она доходит до туриста.
 *
 * ── Что было до 27.09 (владелец: «нужно чтоб всё работало, а не театр») ────
 *
 * Движок скидок существовал, применялся и с 27.09 показывался туристу на форме
 * брони. Назначить скидку при этом не мог НИКТО, кроме администратора:
 * единственный экран правил жил под `/hub/admin/pricing`, а у оператора —
 * владельца тура — такого экрана не было вовсе. Значит правил ноль, и турист
 * видел ту же цену, что и до всей работы: механизм без производителя (§10.09).
 *
 * ── Прогон, которым это закрыто (живое приложение, браузер) ────────────────
 *
 *   турист ДО      18 500 → 15 700  «−15%, последние места»
 *   оператор в UI  ставит 25% за 10 дней; предпросмотр «Турист увидит 13 900 ₽»
 *   турист ПОСЛЕ   18 500 → 13 900  «−25%, последние места»
 *   бронь          base_total_price 18 500, final_price 13 900,
 *                  discount_percent 25, discount_reason «−25%, последние места»
 *
 * ── Что сторож не разрешает ───────────────────────────────────────────────
 *
 * Оператору отданы ДВА рода правил, и только те, что двигают цену вниз. Список
 * заморожен: сезонные окна и надбавка за заполненность поднимают цену либо
 * действуют месяцами, и отдавать их без решения владельца нельзя.
 *
 * Чужой тур — 404. Проверка владения стоит и на удалении: id правила сам по
 * себе ничего о владельце не говорит.
 *
 * Процент переводится в множитель ОДНОЙ функцией. Спутать 0.15 с 0.85 значит
 * дать скидку 85% вместо 15%, и такая опечатка стоит денег сразу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPERATOR_RULE_TYPES, OPERATOR_RULE_LABEL, MAX_OPERATOR_DISCOUNT,
  discountToMultiplier, multiplierToDiscount, isOperatorRuleType,
} from '@/lib/tours/operator-discount';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*--.*$/gm, '');
const ROUTE = read('app/api/hub/operator/pricing-rules/route.ts');
const ROUTE_CODE = code(ROUTE);
const SCREEN = read('app/hub/operator/pricing/_PricingClient.tsx');
const SCREEN_CODE = code(SCREEN);
const NAV = read('app/hub/operator/layout.tsx');

describe('процент и множитель не путаются', () => {
  it('минус пятнадцать процентов — это 0.85, а не 0.15', () => {
    expect(discountToMultiplier(15)).toBe(0.85);
    expect(discountToMultiplier(25)).toBe(0.75);
    expect(discountToMultiplier(50)).toBe(0.5);
  });

  it('обратный перевод даёт ровно то же число', () => {
    for (const p of [1, 5, 15, 25, 33, 50]) {
      expect(multiplierToDiscount(discountToMultiplier(p)), `${p}%`).toBe(p);
    }
  });

  it('множитель строкой из базы читается', () => {
    // `numeric` приходит из PostgreSQL строкой.
    expect(multiplierToDiscount('0.85')).toBe(15);
  });

  it('не скидка — null, а не ноль процентов', () => {
    // Надбавка и «цена не меняется» — не скидки, и рисовать «−0%» нельзя.
    expect(multiplierToDiscount(1)).toBeNull();
    expect(multiplierToDiscount(1.2)).toBeNull();
    expect(multiplierToDiscount('чепуха')).toBeNull();
  });

  it('процент за границами обрезается, а не превращается в отсутствие скидки', () => {
    expect(discountToMultiplier(0)).toBe(0.99);
    expect(discountToMultiplier(-5)).toBe(0.99);
    expect(discountToMultiplier(90)).toBe(discountToMultiplier(MAX_OPERATOR_DISCOUNT));
  });
});

describe('оператору отданы только скидки, и только два рода', () => {
  it('список заморожен', () => {
    expect([...OPERATOR_RULE_TYPES]).toEqual(['last_minute', 'group_discount']);
  });

  it('родов, поднимающих цену, среди них нет', () => {
    for (const forbidden of ['season_peak', 'occupancy_high', 'early_bird', 'weekend', 'season_low']) {
      expect(isOperatorRuleType(forbidden), `${forbidden} отдан оператору`).toBe(false);
    }
  });

  it('у каждого рода есть подпись и пояснение для человека', () => {
    for (const t of OPERATOR_RULE_TYPES) {
      expect(OPERATOR_RULE_LABEL[t]?.title).toBeTruthy();
      expect(OPERATOR_RULE_LABEL[t]?.hint.length).toBeGreaterThan(30);
    }
  });

  it('схема роута принимает ровно этот список, а не свой', () => {
    expect(ROUTE_CODE).toMatch(/z\.enum\(OPERATOR_RULE_TYPES/);
    expect(ROUTE_CODE, 'роут завёл свой список родов').not.toMatch(/'season_peak'/);
  });
});

describe('свой тур и чужой', () => {
  it('владение проверяется до записи', () => {
    expect(ROUTE_CODE).toMatch(/if \(!await ownTourOrNull\(operatorId, d\.tourId\)\)/);
    expect(ROUTE_CODE).toMatch(/WHERE id = \$1 AND operator_id = \$2/);
  });

  it('на удалении владение проверяется В ЗАПРОСЕ, а не до него', () => {
    // Отдельная проверка до UPDATE оставила бы окно между ними.
    const at = ROUTE_CODE.indexOf('export async function DELETE');
    expect(at).toBeGreaterThan(0);
    const block = ROUTE_CODE.slice(at);
    expect(block).toMatch(/EXISTS \(/);
    expect(block).toMatch(/ot\.operator_id = \$2/);
  });

  it('оператор без партнёрской записи получает отказ, а не пустой список', () => {
    expect((ROUTE_CODE.match(/Профиль оператора не найден/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('условие рода обязательно', () => {
  it('«последние места» без окна дней отвергаются', () => {
    // Иначе скидка на последние места действовала бы ВСЕГДА.
    expect(ROUTE_CODE).toMatch(/d\.ruleType === 'last_minute' && d\.daysBefore === undefined/);
    expect(ROUTE).toMatch(/Укажите, за сколько дней до выезда/);
  });

  it('«скидка группе» без числа человек отвергается', () => {
    expect(ROUTE_CODE).toMatch(/d\.ruleType === 'group_discount' && d\.guestsMin === undefined/);
  });

  it('второе правило того же рода не добавляется к первому, а заменяет его', () => {
    // Две «скидки на последние места» перемножились бы: −15% и −15% дали бы
    // −27,75%. Прежнее гасится в ТОМ ЖЕ запросе, что вставляет новое.
    expect(ROUTE_CODE).toMatch(/UPDATE tour_pricing_rules SET is_active = FALSE/);
    expect(ROUTE_CODE).toMatch(/rule_type = \$2 AND is_active = TRUE/);
    const at = ROUTE_CODE.indexOf('WITH off AS (');
    expect(at, 'гашение прежнего правила вынесено из запроса вставки').toBeGreaterThan(0);
    expect(ROUTE_CODE.slice(at, at + 600)).toMatch(/INSERT INTO tour_pricing_rules/);
  });
});

describe('экран показывает ту же цену, что посчитает сервер', () => {
  it('предпросмотр зовёт те же две функции, что бронь', () => {
    // Своя арифметика показала бы оператору одну цифру, а счёт выставил другую.
    expect(SCREEN_CODE).toMatch(/finalUnitPrice\(t\.basePrice, discountToMultiplier\(percent\)\)/);
    expect(SCREEN_CODE).toMatch(/bookingTotal\(\{/);
    expect(SCREEN_CODE, 'экран считает округление сам').not.toMatch(/\/ 100\) \* 100/);
  });

  it('экран не заводит своих родов правил и своего потолка', () => {
    expect(SCREEN_CODE).toMatch(/OPERATOR_RULE_TYPES\.map/);
    expect(SCREEN_CODE).toMatch(/MAX_OPERATOR_DISCOUNT/);
    expect(SCREEN_CODE, 'экран зашил свой предел скидки').not.toMatch(/max=\{50\}/);
  });

  it('отказ сервера показывается человеку, а не глушится', () => {
    expect(SCREEN_CODE).toMatch(/role="alert"/);
    expect(SCREEN_CODE).toMatch(/setError\(/);
  });
});

describe('экран достижим', () => {
  it('пункт «Скидки» есть в меню кабинета оператора', () => {
    // Страница без пункта меню — сирота: её находят только по прямой ссылке.
    expect(NAV).toMatch(/href: '\/hub\/operator\/pricing', label: 'Скидки'/);
  });
});
