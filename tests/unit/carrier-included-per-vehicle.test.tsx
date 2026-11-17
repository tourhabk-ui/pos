/**
 * «Лагуна Прокат» (1318): водитель и топливо — по машине, и оба блока
 * страницы говорят одно и то же (#3487, п.26 и п.27).
 *
 * Было: «О перевозчике» называло две машины с водителем одной фразой и тут же
 * «Топливо — за счёт арендатора», а «Что входит в цену» — «входят ли топливо
 * и подача машины — уточняется». Условия прайса той же 1318 при этом разные
 * у разных машин: у Ford Transit водитель входит в стоимость (по сайту), у
 * «Урала» — не сказано.
 *
 * Судится рендером страницы на данных 1318 с описанием, которое пишет 1459
 * (берётся из самой миграции), и вызовом правила.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/database', () => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));

import { CarrierPage } from '@/components/transfers/CarrierPage';
import { includedUnknowns, vehicleTerms } from '@/lib/transfers/carrier-view';
import type { CarrierProfile, CharterRate } from '@/lib/transfers/charter-format';
import type { CarrierPageData } from '@/lib/transfers/carrier-page';

const MIGRATION = readFileSync(join(process.cwd(), 'migrations/1459_data_consistency_3487.sql'), 'utf8');

/** Новое описание — второй аргумент replace() в правке «Лагуна Прокат». */
function descriptionFrom1459(): string {
  const m = MIGRATION.match(/UPDATE partners\s+SET description = replace\(description,\s*'[^']*',\s*'([^']*)'\)/);
  if (!m) throw new Error('правка описания «Лагуна Прокат» в 1459 не найдена');
  return 'Прокат при СПА-отеле «Лагуна» в Паратунке. Без водителя: Suzuki Jimny, Tank-300 и вездеход Sever Truck '
    + '(его можно взять и с водителем — цену водителя называет прокатчик). ' + m[1]
    + ' Ведар оплату не принимает: заказ и расчёт — напрямую с прокатчиком.';
}

const FROM_NOTE = 'цена «от» — точную назовёт перевозчик';
/** Условия строк прайса — дословно 1318. */
const RATES: CharterRate[] = [
  {
    unit: 'day', vehicleKind: 'minibus', priceRub: 25000, note: FROM_NOTE, validYear: null,
    conditions: 'водитель входит в стоимость — по сайту перевозчика; подача, топливо и число часов в сутках не названы',
  },
  {
    unit: 'day', vehicleKind: 'vahtovka', priceRub: 50000, note: FROM_NOTE, validYear: null,
    conditions: 'профессиональный водитель и разрешительная документация на перевозку людей — по сайту перевозчика; входит ли водитель в цену, не сказано',
  },
];

const LAGUNA: CarrierProfile = {
  partnerId: 'p-lp', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  shortDescription: 'Машины напрокат без водителя и микроавтобус с водителем', description: descriptionFrom1459(),
  verified: false, logo: null,
  vehicles: [
    { kind: 'minibus', title: 'Ford Transit', seats: 17 },
    { kind: 'vahtovka', title: 'Урал ГИРД (вахтовка)', seats: 25 },
  ],
  destinations: [], extraDay: null, rates: RATES, seatClasses: [],
  photos: [], clips: [], video: null, legal: null, license: null, passengerInsurance: null,
  phone: '+79060835070', telegramHref: null, whatsappHref: null,
};

const DATA: CarrierPageData = {
  carrier: LAGUNA,
  safety: { state: 'ok', byPlace: {} },
  reviews: { state: 'ok', items: [], count: 0, average: null },
  rental: { state: 'ok', has: true },
};

beforeEach(() => cleanup());

function block(name: string): HTMLElement {
  return screen.getByRole('heading', { name }).parentElement as HTMLElement;
}

describe('«Лагуна Прокат»: водитель и топливо по машине (#3487)', () => {
  it('«Что входит в цену» — по машине, словами прайса; у Ford Transit топливо не «уточняется»', () => {
    render(<CarrierPage data={DATA} />);
    const items = within(block('Что входит в цену')).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const [ford, ural] = items as [HTMLElement, HTMLElement];
    expect(ford.textContent).toContain('Ford Transit:');
    expect(ford.textContent).toContain('водитель входит в стоимость — по сайту перевозчика');
    expect(ford.textContent).toContain('подача, топливо и число часов в сутках не названы');
    expect(ford.textContent).not.toContain('уточняется');
    expect(ural.textContent).toContain('Урал ГИРД (вахтовка):');
    expect(ural.textContent).toContain('входит ли водитель в цену, не сказано');
    expect(ural.textContent).not.toContain('водитель входит в стоимость');
    expect(ural.textContent).toContain('Не записано: сколько часов в полном дне, входят ли топливо и подача машины — уточняется у перевозчика при заказе.');
  });

  it('«О перевозчике» говорит о водителе по машине то же, что «Что входит в цену», и не обобщает на парк', () => {
    render(<CarrierPage data={DATA} />);
    const about = block('О перевозчике').textContent ?? '';
    expect(about).toContain('Ford Transit на 17 мест — водитель входит в стоимость, по сайту перевозчика');
    expect(about).toContain('вахтовка «Урал» на 25 мест — входит ли водитель в цену, сайт не говорит');
    // Топливо — условие проката без водителя, а не машин с водителем.
    expect(about).toContain('При прокате без водителя топливо — за счёт арендатора');
    expect(about).not.toMatch(/мест\. Топливо — за счёт арендатора/);
  });

  it('правило: названная в условиях тема не идёт в «не записано»; вид один и условия молчат — прежняя фраза', () => {
    const terms = vehicleTerms(LAGUNA);
    expect(terms.map((t) => t.label)).toEqual(['Ford Transit', 'Урал ГИРД (вахтовка)']);
    expect(terms[0]!.unknown).toEqual([]);
    expect(terms[1]!.unknown).toEqual(['сколько часов в полном дне', 'входят ли топливо и подача машины']);

    const fuelOnly: CharterRate = { ...RATES[0]!, conditions: 'топливо — за счёт заказчика' };
    expect(includedUnknowns({ destinations: [], rates: [fuelOnly] })).toBe('сколько часов в полном дне, входит ли подача машины');
    const silent: CharterRate = { ...RATES[0]!, conditions: 'фиксированных направлений нет' };
    expect(includedUnknowns({ destinations: [], rates: [silent] }))
      .toBe('сколько часов в полном дне, входят ли топливо и подача машины');
    expect(vehicleTerms({ destinations: [], rates: [silent], vehicles: [] })[0]!.recorded).toBeNull();
  });
});
