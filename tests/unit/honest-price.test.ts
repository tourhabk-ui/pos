/**
 * Сторож: цена, показанная туристу, и цена в счёте — одна.
 *
 * ── Что нашлось 27.09 (владелец: «им главное скидки») ─────────────────────
 *
 * Движок скидок в платформе был, применялся и туристу не показывался:
 *
 *   - `tour_pricing_rules` умеет last_minute, early_bird, season_low,
 *     season_peak, weekend, group_discount, occupancy_high;
 *   - `GET /api/tours/[id]/price` их применяет — и НЕ ЗОВЁТСЯ ни с одной
 *     страницы сайта;
 *   - `bulkDynamicPrices` зовётся из `/api/octo/availability`: динамическую
 *     цену получал ЧУЖОЙ канал, а наш турист базовую.
 *
 * Рядом нашлись два дефекта самого движка, каждый со своей ценой:
 *
 *   1. цикл сопоставления правил был написан ДВАЖДЫ, по пятьдесят строк, и
 *      РАЗОШЁЛСЯ в источнике занятости: одиночный расчёт брал
 *      `v_tour_daily_occupancy` (реальные брони), bulk — счётчик
 *      `booked_slots`, который видит только оплаченных. На один тур и день
 *      два места платформы отвечали разной ценой;
 *
 *   2. округление до 100 ₽ применялось безусловно, то есть цена менялась и
 *      когда не сработало ни одного правила: тур за 12 950 ₽ показывался за
 *      13 000.
 *
 * ── Чего сторож НЕ разрешает ──────────────────────────────────────────────
 *
 * Правило одно (§12): сопоставление живёт в `lib/tours/pricing-rule-match`, а
 * композиция с суммой брони — в `lib/tours/honest-price`. Своего цикла по
 * `rule_type` во втором месте быть не должно.
 *
 * И главное: бронь считает ТЕМ ЖЕ правилом. Покажи скидку на карточке, оставив
 * `bookingTotal(base_price × участники)` в `reserve.ts`, — человек увидел бы
 * «−15%, последние места», а в заявке получил полную сумму. Это хуже, чем не
 * показывать скидку: обещание цены, которое платформа не держит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composeHonestPrice, priceLabel, changePercentOf, RULE_LABEL,
} from '@/lib/tours/honest-price';
import {
  matchPricingRules, ruleApplies, finalUnitPrice, roundedPrice,
  daysBeforeTour, isWeekendDate, inSeasonWindow, type PricingRule,
} from '@/lib/tours/pricing-rule-match';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
/** Код без комментариев: в них старая форма описана — и должна быть. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const RESERVE = code(read('lib/bookings/reserve.ts'));
const FORM = read('components/marketplace/BookingFormClient.tsx');
/** Без комментариев: в шапке поля правила названы по имени — и должны быть. */
const FORM_CODE = code(FORM);
const DYNAMIC = code(read('lib/services/tours/dynamic-pricing.ts'));
const HONEST = code(read('lib/tours/honest-price.ts'));

const rule = (over: Partial<PricingRule>): PricingRule => ({
  rule_type: 'last_minute', date_from: null, date_to: null,
  days_before_min: null, days_before_max: null,
  occupancy_min: null, guests_min: null, multiplier: '0.85', ...over,
});

describe('множитель 1 не трогает цену', () => {
  it('нет правил — цена как записал оператор, без округления', () => {
    // 12 950 не кратно сотне: безусловное округление было бы видно сразу.
    expect(finalUnitPrice(12950, 1)).toBe(12950);
    expect(matchPricingRules([], { tourDate: '2027-07-10', guests: 2, occupancyPct: 0 }).multiplier).toBe(1);
  });

  it('правила есть, но ни одно не сработало — тоже не трогает', () => {
    const r = rule({ rule_type: 'group_discount', guests_min: 10 });
    const m = matchPricingRules([r], { tourDate: '2027-07-10', guests: 2, occupancyPct: 0 });
    expect(m.multiplier).toBe(1);
    expect(finalUnitPrice(12950, m.multiplier)).toBe(12950);
  });

  it('сработавшее правило округляет до сотни, как было и раньше', () => {
    expect(roundedPrice(12950, 0.85)).toBe(11000);
    expect(finalUnitPrice(12950, 0.85)).toBe(11000);
  });
});

describe('какие правила срабатывают', () => {
  const ctx = { tourDate: '2027-07-10', guests: 2, occupancyPct: 0 };

  it('last_minute — по окну «за сколько дней»', () => {
    const now = new Date('2027-07-07T00:00:00Z');
    expect(daysBeforeTour('2027-07-10', now)).toBe(3);
    expect(ruleApplies(rule({ days_before_min: 0, days_before_max: 7 }), { ...ctx, now })).toBe(true);
    expect(ruleApplies(rule({ days_before_min: 0, days_before_max: 2 }), { ...ctx, now })).toBe(false);
  });

  it('group_discount — по числу гостей', () => {
    const r = rule({ rule_type: 'group_discount', guests_min: 4 });
    expect(ruleApplies(r, { ...ctx, guests: 4 })).toBe(true);
    expect(ruleApplies(r, { ...ctx, guests: 3 })).toBe(false);
  });

  it('occupancy_high — по занятости, которую передал вызывающий', () => {
    const r = rule({ rule_type: 'occupancy_high', occupancy_min: 80, multiplier: '1.1' });
    expect(ruleApplies(r, { ...ctx, occupancyPct: 80 })).toBe(true);
    expect(ruleApplies(r, { ...ctx, occupancyPct: 79 })).toBe(false);
  });

  it('сезонное окно читается и через год', () => {
    expect(inSeasonWindow(rule({ date_from: '2027-07-01', date_to: '2027-08-31' }), '2027-07-10')).toBe(true);
    expect(inSeasonWindow(rule({ date_from: '2027-07-01', date_to: '2027-08-31' }), '2027-10-10')).toBe(false);
    // Окно 15.12-15.01 — через границу года.
    expect(inSeasonWindow(rule({ date_from: '2027-12-15', date_to: '2028-01-15' }), '2028-01-05')).toBe(true);
  });

  it('выходной — пятница, суббота, воскресенье', () => {
    expect(isWeekendDate('2027-07-10')).toBe(true);  // суббота
    expect(isWeekendDate('2027-07-13')).toBe(false); // вторник
  });

  it('незнакомый род не применяется и не роняет расчёт', () => {
    // Молча применить его как «ничего» безопасно; молча как скидку — нет.
    expect(ruleApplies(rule({ rule_type: 'нечто_новое' }), ctx)).toBe(false);
  });

  it('испорченный множитель пропускается, а не считается единицей молча', () => {
    const m = matchPricingRules(
      [rule({ multiplier: 'чепуха' }), rule({ multiplier: '0' }), rule({ multiplier: '0.9' })],
      { tourDate: '2027-07-10', guests: 2, occupancyPct: 0, now: new Date('2027-07-09T00:00:00Z') },
    );
    expect(m.multiplier).toBe(0.9);
    expect(m.appliedRules).toEqual(['last_minute']);
  });

  it('множители перемножаются, и все рода попадают в список', () => {
    const m = matchPricingRules(
      [rule({ multiplier: '0.9' }), rule({ rule_type: 'group_discount', guests_min: 2, multiplier: '0.9' })],
      { tourDate: '2027-07-10', guests: 2, occupancyPct: 0, now: new Date('2027-07-09T00:00:00Z') },
    );
    expect(m.multiplier).toBe(0.81);
    expect(m.appliedRules).toEqual(['last_minute', 'group_discount']);
  });
});

describe('скидка называется словами, а не только числом', () => {
  it('подпись содержит процент и причину', () => {
    expect(priceLabel(0.85, ['last_minute'])).toBe('−15%, последние места');
    expect(priceLabel(1.1, ['season_peak'])).toBe('+10%, высокий сезон');
  });

  it('цена не изменилась — подписи нет вовсе, а не «−0%»', () => {
    // «Скидки нет» и «скидка ноль процентов» человеку читаются по-разному.
    expect(priceLabel(1, ['last_minute'])).toBeNull();
    expect(priceLabel(0.999, ['last_minute'])).toBeNull();
    expect(changePercentOf(1)).toBeNull();
  });

  it('у каждого рода правила есть подпись для человека', () => {
    for (const t of [
      'last_minute', 'early_bird', 'season_low', 'season_peak',
      'weekend', 'group_discount', 'occupancy_high',
    ]) {
      expect(RULE_LABEL[t], `${t}: нет подписи`).toBeTruthy();
    }
  });

  it('незнакомый род не роняет подпись и не пишет своё имя туристу', () => {
    // Английское слово внутри русской фразы хуже пропуска: подпись читает
    // человек, а не лог.
    expect(priceLabel(0.9, ['нечто_новое'])).toBe('−10%');
  });
});

describe('итог брони считается единицей цены, а не только участниками', () => {
  const base = {
    rules: [rule({ days_before_min: 0, days_before_max: 30, multiplier: '0.8' })],
    ctx: { tourDate: '2027-07-10', guests: 4, occupancyPct: 0, now: new Date('2027-07-01T00:00:00Z') },
  };

  it('за человека: скидка на единицу, потом умножение', () => {
    const p = composeHonestPrice({ ...base, baseUnitPrice: 20000, priceUnit: 'per_person', participants: 4 });
    expect(p.finalUnitPrice).toBe(16000);
    expect(p.total).toBe(64000);
    expect(p.baseTotal).toBe(80000);
  });

  it('за группу: цена одна, сколько бы ни ехало', () => {
    const p = composeHonestPrice({ ...base, baseUnitPrice: 20000, priceUnit: 'per_tour', participants: 4 });
    expect(p.total).toBe(16000);
    expect(p.baseTotal).toBe(20000);
  });

  it('за человека в день: скидка не съедает длительность', () => {
    const p = composeHonestPrice({
      ...base, baseUnitPrice: 10000, priceUnit: 'per_day_per_person', participants: 2,
      duration: { multi_day_count: 3, duration_hours: null },
    });
    expect(p.finalUnitPrice).toBe(8000);
    expect(p.total).toBe(48000);
  });
});

describe('правило живёт в одном месте', () => {
  it('сопоставление родов не продублировано в dynamic-pricing', () => {
    // Полсотни строк switch по rule_type были здесь ДВАЖДЫ и разошлись.
    expect(DYNAMIC).toMatch(/matchPricingRules\(/);
    expect(DYNAMIC, 'цикл сопоставления вернулся в dynamic-pricing').not.toMatch(/case 'occupancy_high':/);
    expect(DYNAMIC, 'своё окно сезона вернулось в dynamic-pricing').not.toMatch(/getMonth\(\) \* 100/);
  });

  it('оба расчёта берут занятость из реальных броней, а не из счётчика', () => {
    const occ = DYNAMIC.match(/v_tour_daily_occupancy/g) ?? [];
    expect(occ.length, 'занятость из VIEW не у обоих расчётов').toBeGreaterThanOrEqual(2);
    expect(DYNAMIC, 'счётчик booked_slots вернулся в источник занятости')
      .not.toMatch(/COALESCE\(booked_slots, 0\)/);
  });

  it('honest-price не заводит своего перебора правил', () => {
    expect(HONEST).toMatch(/matchPricingRules\(/);
    expect(HONEST).not.toMatch(/case 'last_minute':/);
  });
});

describe('бронь считает ту же цену, что показана', () => {
  it('reserve зовёт правило, а не base_price напрямую', () => {
    expect(RESERVE).toMatch(/honestTourPrice\(/);
    expect(RESERVE, 'бронь снова считает мимо правил цены')
      .not.toMatch(/bookingTotal\(\{\s*\n?\s*basePrice: Number\(tour\.base_price\)/);
  });

  it('правила читаются клиентом ТОЙ ЖЕ транзакции', () => {
    // Мимо транзакции второе соединение не увидело бы ни FOR UPDATE, ни
    // только что вставленных строк — занятость была бы устаревшей.
    const at = RESERVE.indexOf('honestTourPrice({');
    expect(at).toBeGreaterThan(0);
    expect(RESERVE.slice(at, at + 500)).toMatch(/exec: client/);
  });

  it('цену от клиента бронь не принимает', () => {
    const iface = RESERVE.slice(RESERVE.indexOf('export interface ReserveInput'), RESERVE.indexOf('export interface Reserved'));
    expect(iface).not.toMatch(/price|total|amount|сумма/i);
  });

  it('итог оператора и итог со скидкой пишутся в РАЗНЫЕ колонки', () => {
    // До 27.09 в base_total_price и final_price шло одно значение ($11 дважды),
    // и разбор брони не мог ответить, была ли скидка.
    expect(RESERVE).toMatch(/price\.baseTotal/);
    expect(RESERVE, 'обе колонки снова получают одно значение').not.toMatch(/\$11,\$11/);
  });

  it('надбавка не пишется в колонку с именем «скидка»', () => {
    const at = RESERVE.indexOf('price.changePercent');
    expect(at).toBeGreaterThan(0);
    expect(RESERVE.slice(at, at + 120)).toMatch(/< 0/);
  });
});

describe('форма брони показывает цену выбранной даты', () => {
  it('спрашивает цену у сервера, а не считает правила сама', () => {
    // Правила живут в базе, и считать их в браузере значило бы завести второе
    // правило — с ним расходится счёт.
    expect(FORM).toMatch(/\/api\/tours\/\$\{tourId\}\/price/);
    expect(FORM_CODE, 'форма сама перебирает рода правил').not.toMatch(/last_minute/);
  });

  it('у цены три исхода, и «не сверили» не выдаётся за «скидки нет»', () => {
    // Проверено в браузере 27.09 всеми тремя ветками: без даты 18 500;
    // с датой 18 500 зачёркнуто и 15 700 с подписью «−15%, последние места»;
    // при оборванном запросе — строка о том, что сверить не удалось.
    expect(FORM).toMatch(/'base' \| 'checked' \| 'unchecked'/);
    expect(FORM).toMatch(/Цену на эту дату сверить не удалось/);
  });

  it('без даты правил не существует — показывается цена оператора', () => {
    // last_minute и сезон считаются ОТ ДАТЫ; до её выбора «скидка» была бы
    // выдумкой.
    const at = FORM.indexOf('if (!chosenDate)');
    expect(at).toBeGreaterThan(0);
    expect(FORM.slice(at, at + 200)).toMatch(/status: 'base'/);
  });

  it('прежняя сумма зачёркивается только когда она БОЛЬШЕ новой', () => {
    // Иначе надбавка нарисовалась бы как скидка.
    expect(FORM).toMatch(/priced\.baseTotal > priced\.total/);
  });

  it('запрос отменяется при смене даты или числа людей', () => {
    // Иначе ответ на прежнюю дату мог бы прийти последним и показать цену
    // не той даты.
    expect(FORM).toMatch(/new AbortController\(\)/);
    expect(FORM).toMatch(/ctrl\.abort\(\)/);
    expect(FORM).toMatch(/AbortError/);
  });
});
