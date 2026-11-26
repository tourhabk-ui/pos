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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// С 23.11 скидка идёт на проверку (слово владельца: «цена тура меняется только
// через одну дверь»): роут зовёт дверь lib/tours/pricing-rule-door. Здесь дверь
// подменена — судим, что роут отдаёт ей карточку из входа и честно называет
// исход. Владение, замену просьбы и «действует до решения» судит PostgreSQL —
// tests/integration/pricing-rule-moderation.pg.test.ts.
const USER = 'c6000000-0000-4000-8000-000000000301';
const gate = vi.hoisted(() => ({ propose: vi.fn(), remove: vi.fn(), may: true }));
vi.mock('@/lib/tours/pricing-rule-door', () => ({ proposePricingRule: gate.propose, requestRuleRemoval: gate.remove }));
vi.mock('@/lib/database', () => ({ transaction: async (fn: (client: unknown) => unknown) => fn({ query: vi.fn() }) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/auth/middleware', () => ({ requireOperator: vi.fn() }));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: vi.fn() }));
vi.mock('@/lib/operators/team-access', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireOperatorTeam: vi.fn(async () => ({
      userId: 'c6000000-0000-4000-8000-000000000301', role: 'operator', partnerId: 'partner-1',
      access: { kind: 'owner', partnerId: 'partner-1' },
    })),
    managerMay: () => gate.may,
    permissionDenied: () => NextResponse.json({ success: false, error: 'Нет права менять цены' }, { status: 403 }),
  };
});

const URL = 'http://localhost/api/hub/operator/pricing-rules';
async function post(body: unknown) {
  const { POST } = await import('@/app/api/hub/operator/pricing-rules/route');
  const res = await POST(new NextRequest(URL, { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
async function del(query: string) {
  const { DELETE } = await import('@/app/api/hub/operator/pricing-rules/route');
  const res = await DELETE(new NextRequest(`${URL}${query}`, { method: 'DELETE' }));
  return { status: res.status, body: await res.json() };
}
beforeEach(() => { gate.propose.mockReset(); gate.remove.mockReset(); gate.may = true; });
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
// Меню кабинета — components/operator/operator-menu.ts (CRM 2г), layout его фильтрует.
const NAV = read('components/operator/operator-menu.ts');

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
  it('просьба уходит в дверь с карточкой из входа, а не из тела запроса; чужой тур — 404', async () => {
    gate.propose.mockResolvedValueOnce({ outcome: 'pending', ruleId: '11' });
    const ok = await post({ tourId: 7, ruleType: 'last_minute', percent: 15, daysBefore: 7, operatorId: 'чужая-карточка' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ success: true, id: '11', state: 'pending', multiplier: 0.85 });
    // Не «сохранено»: цена на сайте пока прежняя, и это сказано.
    expect(ok.body.message).toBe('Скидка отправлена на проверку. Туристы увидят её после одобрения администратором.');
    expect(gate.propose.mock.calls[0][1]).toEqual({
      operatorId: 'partner-1', requestedBy: USER, tourId: 7, ruleType: 'last_minute', multiplier: 0.85,
      daysBeforeMin: 0, daysBeforeMax: 7, guestsMin: null,
    });
    // Дверь не нашла тур у этой карточки — 404, а не «отправлено».
    gate.propose.mockResolvedValueOnce({ outcome: 'not_found' });
    const foreign = await post({ tourId: 99, ruleType: 'last_minute', percent: 15, daysBefore: 7 });
    expect(foreign.status).toBe(404);
    expect(foreign.body.success).toBe(false);
  });

  it('скидка группе несёт число человек, а не окно дней', async () => {
    gate.propose.mockResolvedValueOnce({ outcome: 'pending', ruleId: '12' });
    await post({ tourId: 7, ruleType: 'group_discount', percent: 10, guestsMin: 4, daysBefore: 9 });
    expect(gate.propose.mock.calls[0][1]).toMatchObject({
      ruleType: 'group_discount', multiplier: 0.9, guestsMin: 4, daysBeforeMin: null, daysBeforeMax: null,
    });
  });

  it('та же скидка уже действует или уже ждёт — исход назван своими словами, не «отправлена»', async () => {
    gate.propose.mockResolvedValueOnce({ outcome: 'already_live', ruleId: '5' });
    const live = await post({ tourId: 7, ruleType: 'last_minute', percent: 15, daysBefore: 7 });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ state: 'already_live', message: 'Такая скидка уже действует.' });
    gate.propose.mockResolvedValueOnce({ outcome: 'already_pending', ruleId: '6' });
    const waiting = await post({ tourId: 7, ruleType: 'last_minute', percent: 15, daysBefore: 7 });
    expect(waiting.status).toBe(200);
    expect(waiting.body).toMatchObject({ state: 'already_pending', message: 'Такая скидка уже ждёт проверки.' });
  });

  it('на удалении владение проверяет дверь: ей отдана карточка из входа и id правила', async () => {
    gate.remove.mockResolvedValueOnce({ outcome: 'removal_pending' });
    const live = await del('?id=41');
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({
      success: true, state: 'removal_pending',
      message: 'Просьба снять скидку отправлена на проверку. До решения администратора скидка действует.',
    });
    expect(gate.remove.mock.calls[0][1]).toEqual({ operatorId: 'partner-1', ruleId: '41' });
    gate.remove.mockResolvedValueOnce({ outcome: 'withdrawn' });
    expect((await del('?id=42')).body).toMatchObject({ state: 'withdrawn', message: 'Скидка убрана: на цену она не влияла.' });
    // Чужое или несуществующее правило — 404.
    gate.remove.mockResolvedValueOnce({ outcome: 'not_found' });
    expect((await del('?id=43')).status).toBe(404);
  });

  it('id не число — 404, до двери и до базы дело не доходит; без id — 400', async () => {
    expect((await del('?id=41%3B%20DROP')).status).toBe(404);
    expect((await del('?id=-1')).status).toBe(404);
    expect((await del('')).status).toBe(400);
    expect(gate.remove).not.toHaveBeenCalled();
  });

  it('без права менять цены просьба до двери не доходит', async () => {
    gate.may = false;
    expect((await post({ tourId: 7, ruleType: 'last_minute', percent: 15, daysBefore: 7 })).status).toBe(403);
    expect((await del('?id=41')).status).toBe(403);
    expect(gate.propose).not.toHaveBeenCalled();
    expect(gate.remove).not.toHaveBeenCalled();
  });

  it('своей записи правила у роута нет: мимо двери скидка на сайт не выходит', () => {
    expect(ROUTE_CODE).not.toMatch(/INSERT\s+INTO\s+tour_pricing_rules/);
    expect(ROUTE_CODE).not.toMatch(/UPDATE\s+tour_pricing_rules/);
    expect(ROUTE_CODE).not.toMatch(/'approved'/);
  });

  it('оператор без партнёрской записи получает отказ, а не пустой список', () => {
    // GET — своим ответом; запись скидок — через гард кабинета (CRM 2г), он
    // отвечает тем же «Профиль оператора не найден».
    expect((ROUTE_CODE.match(/Профиль оператора не найден/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((ROUTE_CODE.match(/await requireOperatorTeam\(request\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(process.cwd(), 'lib/operators/team-access.ts'), 'utf8')).toMatch(/Профиль оператора не найден/);
  });
});

describe('условие рода обязательно', () => {
  it('«последние места» без окна дней отвергаются — до двери', async () => {
    // Иначе скидка на последние места действовала бы ВСЕГДА.
    const res = await post({ tourId: 7, ruleType: 'last_minute', percent: 15 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Укажите, за сколько дней до выезда действует скидка');
    expect(gate.propose).not.toHaveBeenCalled();
  });

  it('«скидка группе» без числа человек отвергается — до двери', async () => {
    const res = await post({ tourId: 7, ruleType: 'group_discount', percent: 15 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Укажите, от какого числа человек действует скидка');
    expect(gate.propose).not.toHaveBeenCalled();
  });

  it('процент вне 1..50 и чужой род правила отвергаются — до двери', async () => {
    expect((await post({ tourId: 7, ruleType: 'last_minute', percent: 51, daysBefore: 7 })).status).toBe(400);
    expect((await post({ tourId: 7, ruleType: 'last_minute', percent: 0, daysBefore: 7 })).status).toBe(400);
    // Роды, поднимающие цену, оператору не отданы.
    expect((await post({ tourId: 7, ruleType: 'season_peak', percent: 10 })).status).toBe(400);
    expect((await post({ tourId: 7, ruleType: 'weekend_sat_sun', percent: 10 })).status).toBe(400);
    expect(gate.propose).not.toHaveBeenCalled();
  });

  // «Второе правило того же рода не добавляется к первому» (две скидки
  // перемножились бы) теперь держит дверь и очередь: новая просьба заменяет
  // прежнюю неодобренную, одобрение выключает прежнее действующее. Судит
  // PostgreSQL — tests/integration/pricing-rule-moderation.pg.test.ts.
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
