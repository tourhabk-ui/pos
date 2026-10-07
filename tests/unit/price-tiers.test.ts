// @vitest-environment node
/**
 * Цена тура по размеру группы (#2246, миграция 1173).
 *
 * Держится четыре вещи: правило выбора ступени, что ступень — база для того же
 * расчёта, что у брони, что вне ступеней суммы НЕТ (а не базовая цена), и что
 * все двери (бронь, availability, заявка на места, публичная цена) это знают.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickPriceTier, PriceTierMissError, type PriceTier } from '@/lib/tours/price-tiers';
import { composeHonestPrice } from '@/lib/tours/honest-price';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

// Облёт Ключевской группы: 520 000 при группе от 6, 410 000 от 9.
const OBLET: PriceTier[] = [
  { min_people: 6, max_people: 8, price_per_person: 520_000 },
  { min_people: 9, max_people: null, price_per_person: 410_000 },
];

const compose = (participants: number, tiers: PriceTier[] | undefined, priceUnit = 'per_person', rules = [] as never[]) =>
  composeHonestPrice({
    baseUnitPrice: 410_000, priceUnit, participants, rules, tiers,
    ctx: { tourDate: '2027-07-10', guests: participants, occupancyPct: 0 },
  });

describe('pickPriceTier: три исхода', () => {
  it('ступеней нет — none (тур живёт на base_price, как до 07.10)', () => {
    expect(pickPriceTier([], 5, 'per_person')).toEqual({ kind: 'none' });
  });

  it('группа в ступени — hit с ценой за человека', () => {
    expect(pickPriceTier(OBLET, 7, 'per_person')).toMatchObject({ kind: 'hit', pricePerPerson: 520_000 });
    expect(pickPriceTier(OBLET, 9, 'per_person')).toMatchObject({ kind: 'hit', pricePerPerson: 410_000 });
    expect(pickPriceTier(OBLET, 14, 'per_person')).toMatchObject({ kind: 'hit', pricePerPerson: 410_000 });
  });

  it('границы включены с обеих сторон', () => {
    expect(pickPriceTier(OBLET, 6, 'per_person').kind).toBe('hit');
    expect(pickPriceTier(OBLET, 8, 'per_person')).toMatchObject({ pricePerPerson: 520_000 });
  });

  it('группа вне всех ступеней — miss, а не ближайшая ступень', () => {
    expect(pickPriceTier(OBLET, 2, 'per_person')).toEqual({ kind: 'miss', reason: 'out_of_range' });
    expect(pickPriceTier(OBLET, 5, 'per_person')).toEqual({ kind: 'miss', reason: 'out_of_range' });
  });

  it('при перекрытии берётся самая конкретная ступень — с большим min_people', () => {
    const overlap: PriceTier[] = [
      { min_people: 1, max_people: null, price_per_person: 100 },
      { min_people: 5, max_people: null, price_per_person: 80 },
    ];
    expect(pickPriceTier(overlap, 6, 'per_person')).toMatchObject({ pricePerPerson: 80 });
    expect(pickPriceTier(overlap, 3, 'per_person')).toMatchObject({ pricePerPerson: 100 });
  });

  it('ступени у тура «за группу» не применяются: цена за человека там была бы смесью единиц', () => {
    expect(pickPriceTier(OBLET, 7, 'per_tour')).toEqual({ kind: 'miss', reason: 'unit_not_per_person' });
  });
});

describe('composeHonestPrice: ступень — база того же расчёта, что у брони', () => {
  it('одна и та же поездка стоит по-разному для 7 и 10 человек', () => {
    expect(compose(7, OBLET).total).toBe(7 * 520_000);
    expect(compose(10, OBLET).total).toBe(10 * 410_000);
  });

  it('тур без ступеней считается как раньше — ничего не меняется', () => {
    expect(compose(3, undefined).total).toBe(3 * 410_000);
    expect(compose(3, []).total).toBe(3 * 410_000);
  });

  it('группа вне ступеней — PriceTierMissError, а не базовая цена', () => {
    expect(() => compose(2, OBLET)).toThrow(PriceTierMissError);
  });

  it('правила цены (множитель) применяются поверх цены ступени', () => {
    const rules = [{
      rule_type: 'group_discount', date_from: null, date_to: null, days_before_min: null, days_before_max: null,
      occupancy_min: null, guests_min: 6, multiplier: 0.9,
    }] as never[];
    const p = compose(7, OBLET, 'per_person', rules);
    expect(p.baseTotal).toBe(7 * 520_000);
    expect(p.total).toBe(Math.round(7 * 520_000 * 0.9));
  });
});

describe('все двери знают про ступени', () => {
  it('бронь называет отказ кодом PRICE_UNKNOWN, а не падает 500', () => {
    const src = read('lib/bookings/reserve.ts');
    expect(src).toMatch(/'PRICE_UNKNOWN'/);
    expect(src).toMatch(/err instanceof PriceTierMissError\) throw new ReserveError\('PRICE_UNKNOWN'/);
    // Не `.catch` на результате: тесты и обёртки подставляют не-промис.
    expect(src).not.toMatch(/honestTourPrice\([^)]*\}\)\.catch/s);
  });

  it('availability считает тем же honestTourPrice и называет «цену называет оператор»', () => {
    const src = read('lib/kuzmich/tour-availability-tool.ts');
    expect(src).toMatch(/honestTourPrice\(/);
    expect(src).toMatch(/PriceTierMissError/);
    expect(src).toMatch(/цену называет оператор/);
  });

  it('заявка на места отказывает до сообщения оператору, а не после его «есть места»', () => {
    const src = read('lib/seat-requests/service.ts');
    const at = src.indexOf('loadPriceTiers(input.tourId)');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf('reachForPartner(tour.operator_id)'));
    expect(src).toMatch(/reason: 'price_unknown'/);
    expect(read('lib/seat-requests/core.ts')).toMatch(/price_unknown:\s+\{ status: 422/);
  });

  it('публичная цена тура отвечает 422 price_unknown, а не 500', () => {
    const src = read('app/api/tours/[id]/price/route.ts');
    expect(src).toMatch(/PriceTierMissError/);
    expect(src).toMatch(/code: 'price_unknown'/);
  });

  it('отказ чтения ступеней не превращается в «ступеней нет»', () => {
    const src = read('lib/tours/honest-price.ts');
    const fn = src.slice(src.indexOf('export async function loadPriceTiers'), src.indexOf('export async function loadPricingContext'));
    expect(fn).not.toMatch(/catch/);
  });
});
