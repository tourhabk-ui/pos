/**
 * Тарифы «за день» на РАЗНЫЕ виды машин у одного перевозчика — миграция 1318,
 * «Лагуна Прокат»: микроавтобус 25 000 ₽ и вахтовка от 50 000 ₽ за сутки.
 *
 * До 23.10 тариф (1292) не знал вида машины — у «ИП Желтухин» он один. С двумя
 * видами старый код лгал бы четырьмя способами: на странице две строки «Полный
 * день» с разной ценой без объяснения, в колонке заявки «25 000 ₽ за день ·
 * 50 000 ₽ за день за машину», в источнике лида два ключа «day» затирали друг
 * друга (оставался только 50 000), а планер называл цену микроавтобуса ценой
 * перевозчика без «от». Судится рендером и вызовом; у одного вида слова не
 * меняются — это держит carrier-hourly-rates.test.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { dbQuery, charterMock } = vi.hoisted(() => ({ dbQuery: vi.fn(), charterMock: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/transfers/charter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transfers/charter')>()),
  loadCharterCarriers: (...a: unknown[]) => charterMock(...a),
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));

import { CarrierPage } from '@/components/transfers/CarrierPage';
import {
  rateKey, rateLabelOf, rateOnScreenOf, rateWords, type CarrierProfile, type CharterRate,
} from '@/lib/transfers/charter-format';
import { carrierJsonLd } from '@/lib/transfers/carrier-view';
import { charterAnswer } from '@/lib/kuzmich/transfer-search';
import {
  charterAcceptedText, charterLeadComment, charterSourceData, planCharterRequest,
} from '@/lib/transfers/charter-request';
import { findCharterOffers } from '@/lib/planner/trip-extras-data';
import { charterOfferPrice } from '@/app/planner/TripExtrasSection';
import type { CarrierPageData } from '@/lib/transfers/carrier-page';

const plain = (s: string | null | undefined): string => (s ?? '').replace(/[  ]/g, ' ');

const FROM_NOTE = 'цена «от» — точную назовёт перевозчик';
const RATES: CharterRate[] = [
  { unit: 'day', vehicleKind: 'minibus', priceRub: 25000, note: FROM_NOTE, conditions: 'водитель входит в стоимость — по сайту перевозчика', validYear: null },
  { unit: 'day', vehicleKind: 'vahtovka', priceRub: 50000, note: FROM_NOTE, conditions: 'профессиональный водитель — по сайту перевозчика; входит ли водитель в цену, не сказано', validYear: null },
];

const LAGUNA: CarrierProfile = {
  partnerId: 'p-lp', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  shortDescription: 'Машины напрокат и микроавтобус с водителем', description: 'Прокат при СПА-отеле «Лагуна».', verified: false,
  vehicles: [
    { kind: 'minibus', title: 'Ford Transit', seats: 17 },
    { kind: 'vahtovka', title: 'Урал ГИРД (вахтовка)', seats: 25 },
  ],
  destinations: [], extraDay: null, rates: RATES, seatClasses: [],
  photos: [], clips: [], video: null, legal: null, license: null, passengerInsurance: null,
  phone: '+79060835070', telegramHref: 'https://t.me/+79060835070', whatsappHref: null,
};

const DATA: CarrierPageData = {
  carrier: LAGUNA,
  safety: { state: 'ok', byPlace: {} },
  reviews: { state: 'ok', items: [], count: 0, average: null },
};

beforeEach(() => {
  cleanup();
  dbQuery.mockReset();
  charterMock.mockReset();
});

describe('слова тарифа: вид машины называется только когда видов несколько', () => {
  it('один вид — как раньше; два вида — подпись, цена на экране и слова агенту несут вид', () => {
    const one = [RATES[0]!];
    expect(rateLabelOf(RATES[0]!, one)).toBe('Полный день');
    expect(plain(rateOnScreenOf(RATES[0]!, one))).toBe('25 000 ₽ за день');
    expect(rateWords({ ...RATES[0]!, note: null }, one)).toBe('25000 руб за полный день работы машины');

    expect(rateLabelOf(RATES[0]!, RATES)).toBe('Полный день — микроавтобус');
    expect(rateLabelOf(RATES[1]!, RATES)).toBe('Полный день — вахтовка');
    expect(plain(rateOnScreenOf(RATES[1]!, RATES))).toBe('вахтовка: 50 000 ₽ за день');
    expect(rateWords(RATES[0]!, RATES)).toBe(`микроавтобус — 25000 руб за полный день работы машины (${FROM_NOTE})`);
    expect(rateKey(RATES[0]!)).not.toBe(rateKey(RATES[1]!));
  });
});

describe('страница перевозчика с двумя тарифами за день', () => {
  it('прайс: каждая строка подписана видом машины и своей ценой; «Заказать» различимы', () => {
    render(<CarrierPage data={DATA} />);
    const labels = screen.getAllByRole('term').map((el) => plain(el.textContent));
    expect(labels).toEqual(expect.arrayContaining(['Полный день — микроавтобус', 'Полный день — вахтовка']));
    expect(labels.filter((l) => l === 'Полный день')).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Заказать машину: полный день — микроавтобус' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Заказать машину: полный день — вахтовка' })).toBeTruthy();
  });

  it('колонка заявки называет цену каждого вида, а не два одинаковых «за день»', () => {
    const { container } = render(<CarrierPage data={DATA} />);
    const text = plain(container.textContent);
    expect(text).toContain('микроавтобус: 25 000 ₽ за день · вахтовка: 50 000 ₽ за день за машину');
    expect(text).not.toContain('25 000 ₽ за день · 50 000 ₽ за день за машину');
  });

  it('разметка: два Offer с разными именами, оба за DAY', () => {
    const ld = carrierJsonLd(LAGUNA, 'https://vedarai.ru') as { makesOffer: Array<{ itemOffered: { name: string }; priceSpecification: { price: number; unitCode: string } }> };
    const names = ld.makesOffer.map((o) => o.itemOffered.name);
    expect(names).toEqual(['Машина целиком: полный день — микроавтобус', 'Машина целиком: полный день — вахтовка']);
    expect(ld.makesOffer.map((o) => o.priceSpecification.price)).toEqual([25000, 50000]);
    expect(new Set(ld.makesOffer.map((o) => o.priceSpecification.unitCode))).toEqual(new Set(['DAY']));
  });
});

describe('заявка, Кузьмич и MCP — обе цены с видом машины', () => {
  const base = 'https://vedarai.ru';
  const facts = () => {
    const plan = planCharterRequest(LAGUNA, 'Авачинский перевал', 10);
    if (plan.kind !== 'rated') throw new Error('ожидался rated');
    return { carrier: LAGUNA, plan, destination: 'Авачинский перевал', dateFrom: '2027-07-10', dateTo: null, passengers: 10, comment: null };
  };

  it('источник лида хранит ОБЕ цены: ключ «вид/единица», ничего не затёрто', () => {
    expect(charterSourceData(facts(), 'form')).toMatchObject({
      in_price_list: false,
      rates_rub: { 'minibus/day': 25000, 'vahtovka/day': 50000 },
    });
  });

  it('комментарий менеджеру и ответ агенту называют вид у каждой цены', () => {
    const f = facts();
    const comment = charterLeadComment(f);
    expect(comment).toContain('микроавтобус — 25000 руб за полный день работы машины');
    expect(comment).toContain('вахтовка — 50000 руб за полный день работы машины');
    const accepted = charterAcceptedText(f, '+79001234567', base);
    expect(accepted).toContain('микроавтобус — 25000 руб за полный день работы машины');
    expect(accepted).toContain('вахтовка — 50000 руб за полный день работы машины');
    // Телефон перевозчика агенту не уходит (pd-guard).
    expect(accepted).not.toContain('9060835070');
  });

  it('ответ Кузьмича и MCP: цена каждого вида, сколько мест в какой машине', () => {
    const text = charterAnswer([LAGUNA], undefined, base, { surface: 'mcp' });
    expect(text).toContain('1 × микроавтобус, 17 мест; 1 × вахтовка, 25 мест');
    expect(text).toContain('микроавтобус — 25000 руб за полный день работы машины');
    expect(text).toContain('вахтовка — 50000 руб за полный день работы машины');
    expect(text).not.toContain('9060835070');
  });
});

describe('планер: цена перевозчика с двумя видами — самая низкая и «от»', () => {
  it('dayRub — минимум, ratesFrom — true; строка плана говорит «от»; у одного вида «от» нет', async () => {
    charterMock.mockResolvedValue([LAGUNA]);
    const r = await findCharterOffers();
    if (r.state !== 'ok') throw new Error('ожидался прайс');
    expect(r.items[0]).toMatchObject({ slug: 'laguna-prokat', hourRub: null, dayRub: 25000, ratesFrom: true });
    expect(plain(charterOfferPrice(r.items[0]!))).toBe('от 25 000 ₽ за день за машину · направление — ваше');
    expect(plain(charterOfferPrice({ priceFromRub: null, destinations: 0, hourRub: null, dayRub: 45000, ratesFrom: false })))
      .toBe('45 000 ₽ за день за машину · направление — ваше');
  });
});

describe('миграция 1318: только то, что сказал сайт прокатчика', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations', '1318_laguna_prokat_carrier_and_rental.sql'), 'utf-8');

  it('две строки per_day на разные виды машин: микроавтобус 25 000, вахтовка 50 000 — с пометкой «от»', () => {
    expect(sql).toMatch(/\('minibus',\s*25000,/);
    expect(sql).toMatch(/\('vahtovka',\s*50000,/);
    expect((sql.match(/'per_day'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain('цена «от» — точную назовёт перевозчик');
    expect(sql).not.toMatch(/'destination'|'per_hour'|'extra_day'/);
  });

  it('парк — две машины с водителем, места с сайта; без водителя — три предложения проката', () => {
    expect(sql).toMatch(/'Ford Transit',\s*17\)/);
    expect(sql).toMatch(/'Урал ГИРД \(вахтовка\)',\s*25\)/);
    for (const title of ['Suzuki Jimny', 'Tank-300', 'Sever Truck']) expect(sql).toContain(`('${title}',`);
    expect(sql).toMatch(/'Sever Truck'[^;]*'optional'/);
  });

  it('источник назван, цены — за машину; юрлицо, фото и «проверен» не выдуманы', () => {
    expect(sql).toMatch(/--[^\n]*Источник:[^\n]*лагунапрокат\.рф/);
    expect(sql).not.toMatch(/за место/i);
    expect(sql).not.toMatch(/'inn'|'ogrn'|'companyName'/);
    expect(sql).not.toMatch(/\/images\//);
    // rating, review_count, is_verified, is_public
    expect(sql).toMatch(/0,\s*0,\s*FALSE,\s*TRUE,\s*NOW\(\)/);
    // Номер контакта группы, который дал владелец, в репозиторий не пишется: здесь только номер с сайта фирмы.
    expect(new Set(sql.match(/\+79\d{9}/g))).toEqual(new Set(['+79060835070']));
  });
});
