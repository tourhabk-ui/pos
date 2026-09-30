/**
 * Ленты чужих витрин: цена вместе с тем, за что она, и без туров, чей сезон
 * кончился.
 *
 * Замер 30.09 (фиды на проде): «Осенняя рыбалка» — 25 000 ₽ за человека в
 * день, «Семейный тур выходного дня» — 45 000 ₽ за группу, а в обеих лентах
 * лежали голые 25000 и 45000. Тот же «Семейный тур» с сезоном до 15.09 шёл на
 * Авито живым объявлением: у Яндекса есть available="false", у Авито — нет.
 * Шапки: lib/channels/price-line.ts, lib/channels/avito.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { priceLine, priceUnitPhrase } from '@/lib/channels/price-line';
import { generateAvitoXmlFeed } from '@/lib/channels/avito';
import { generateYandexYmlFeed } from '@/lib/channels/yandex';
import type { ChannelTour } from '@/lib/channels/types';

const base: ChannelTour = {
  id: 7,
  title: 'Семейный тур выходного дня',
  description: 'Семейная рыбалка на 2 дня с проживанием на базе.',
  short_description: null,
  activity_type: 'fishing',
  location_name: 'Рыболовная база',
  latitude: 53.1,
  longitude: 157.9,
  base_price: 45000,
  max_participants: 6,
  duration_hours: 48,
  difficulty: 'easy',
  photos: ['/images/a.jpg'],
  included: [],
  season_start: '2026-06-01',
  season_end: '2026-09-15',
  price_unit: 'per_tour',
  availability: 'on_request',
  operator_name: 'Камчатская рыбалка',
  operator_phone: '+7 900 000-00-00',
  tripster_experience_id: null,
  avito_listing_id: null,
  sputnik8_product_id: null,
};

describe('строка цены', () => {
  it('единица из общего словаря карточки тура', () => {
    expect(priceLine(45000, 'per_tour')).toBe('Цена: 45 000 ₽ за группу.');
    expect(priceLine(25000, 'per_day_per_person')).toBe('Цена: 25 000 ₽ за чел./день.');
    expect(priceLine(13000, 'per_person')).toBe('Цена: 13 000 ₽ за человека.');
  });

  it('единица не записана — так и сказано, «за человека» не подставляется', () => {
    expect(priceUnitPhrase(null)).toBeNull();
    expect(priceUnitPhrase('per_something')).toBeNull();
    expect(priceLine(45000, null)).toContain('уточните у оператора');
    expect(priceLine(45000, null)).not.toContain('за человека.');
  });
});

describe('Авито', () => {
  it('в описании объявления первой строкой цена с единицей', () => {
    const { xml } = generateAvitoXmlFeed([base]);
    expect(xml).toContain('<Description>Цена: 45 000 ₽ за группу.');
  });

  it('тур с кончившимся сезоном не выходит объявлением и назван пропуском', () => {
    const { xml, skipped } = generateAvitoXmlFeed([{ ...base, availability: 'season_over' }]);
    expect(xml).not.toContain('<Id>7</Id>');
    expect(skipped).toEqual([{ id: 7, activity_type: 'fishing', reason: 'season_over' }]);
  });

  it('роут считает пропуск по сезону отдельно от пропуска по категории', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/channels/avito/feed/route.ts'), 'utf-8');
    expect(route).toContain("'X-Skipped-Season-Over'");
    expect(route).toContain("s.reason === 'no_category'");
  });
});

describe('Яндекс', () => {
  it('цена с единицей в описании, параметре и sales_notes', () => {
    const xml = generateYandexYmlFeed([base]);
    expect(xml).toContain('<description>Цена: 45 000 ₽ за группу.');
    expect(xml).toContain('<param name="Цена указана">за группу</param>');
    expect(xml).toContain('<sales_notes>Цена за группу</sales_notes>');
  });

  it('available берётся из общего правила дат, когда отбор его посчитал', () => {
    expect(generateYandexYmlFeed([{ ...base, availability: 'season_over' }])).toContain('available="false"');
    // Даты есть — тур продаётся, даже если записанный сезон уже позади.
    expect(generateYandexYmlFeed([{ ...base, availability: 'dates' }])).toContain('available="true"');
  });
});

describe('отбор лент', () => {
  it('даты считаются тем же EXISTS и тем же правилом, что у каталога', () => {
    const src = readFileSync(join(process.cwd(), 'lib/channels/ready-tours.ts'), 'utf-8');
    expect(src).toContain('${hasAvailabilitySql()}');
    expect(src).toContain('catalogAvailability(');
    expect(src).toContain('ot.price_unit');
  });
});
