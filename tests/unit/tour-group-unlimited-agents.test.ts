/**
 * «Группа не ограничена» в словах для агентов и в текстах тура (1341, слово
 * владельца 29.10). Тот же признак, что на карточке
 * (tests/unit/tour-group-unlimited.test.tsx): агент MCP, Кузьмич, собранное
 * описание, пост канала и фид Яндекса при TRUE слышат «не ограничена» и
 * потолок ОДНОЙ заявки на сайте — иначе пообещали бы бронь, которую форма не
 * примет, или назвали бы «до 12» пределом гида. Судится вызовом на
 * подложенных данных, не строкой исходника.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query }, transaction: vi.fn() }));

import {
  BOOKING_FORM_MAX_PARTICIPANTS, bookingRequestCeiling, groupSentence, groupShort, groupStripValue, isGroupSizeUnlimited,
} from '@/lib/tours/group-size';
import { composeTourDescription } from '@/lib/tours/describe';
import { getTourDetails } from '@/lib/kuzmich/core';
import { fetchDocument } from '@/lib/mcp/connector-tools';
import { buildTourPostText } from '@/lib/notifications/tour-channel-post';
import { generateYandexYmlFeed } from '@/lib/channels/yandex';
import type { ChannelTour } from '@/lib/channels/types';

beforeEach(() => query.mockReset());

const UNLIMITED_12 = 'Группа не ограничена (одна заявка на сайте — до 12 человек).';

describe('правило группы (lib/tours/group-size)', () => {
  it('TRUE — «не ограничена» и потолок заявки: меньшее из числа тура и потолка формы', () => {
    expect(BOOKING_FORM_MAX_PARTICIPANTS).toBe(12);
    expect(groupStripValue({ max_participants: 12, group_size_unlimited: true })).toBe('не ограничена');
    expect(groupSentence({ max_participants: 12, group_size_unlimited: true })).toBe(UNLIMITED_12);
    expect(groupSentence({ max_participants: 40, group_size_unlimited: true })).toBe(UNLIMITED_12);
    expect(groupSentence({ max_participants: 10, group_size_unlimited: true }))
      .toBe('Группа не ограничена (одна заявка на сайте — до 10 человек).');
    expect(groupSentence({ max_participants: null, group_size_unlimited: true })).toBe('Группа не ограничена.');
    expect(groupShort({ max_participants: 12, group_size_unlimited: true })).toBe('группа не ограничена');
  });

  it('FALSE, NULL и нет поля — прежнее «до N»; числа нет — молчание, а не «до 0»', () => {
    for (const flag of [false, null, undefined]) {
      expect(isGroupSizeUnlimited({ max_participants: 12, group_size_unlimited: flag })).toBe(false);
      expect(groupStripValue({ max_participants: 12, group_size_unlimited: flag })).toBe('до 12');
      expect(groupSentence({ max_participants: 12, group_size_unlimited: flag })).toBe('Группа до 12 человек.');
      expect(groupShort({ max_participants: 12, group_size_unlimited: flag })).toBe('до 12 чел.');
    }
    expect(groupStripValue({ max_participants: 0 })).toBeNull();
    expect(groupSentence({ max_participants: null })).toBeNull();
    expect(bookingRequestCeiling('8')).toBe(8);
    expect(bookingRequestCeiling(0)).toBeNull();
  });
});

describe('собранное описание тура (composeTourDescription)', () => {
  // Данных хватает на порог витрин (300 знаков): иначе текста нет вовсе.
  const facts = {
    title: 'Курильское озеро на внедорожнике', location_name: 'Курильское озеро', duration_hours: 72,
    difficulty: 'easy', season_start: '2027-07-19', season_end: '2027-09-30', max_participants: 12, weather_dependent: true,
    program: [
      { title: 'Выезд', text: 'ранний старт из города, дорога на юг полуострова по грунтовке' },
      { title: 'Озеро', text: 'смотровые площадки, медведи на нерестовых реках, вулкан Ильинский' },
      { title: 'Обратно', text: 'возвращение в город к вечеру третьего дня' },
    ],
    included: ['Трансфер', 'Гид', 'Сбор заказника'],
    what_to_bring: ['Треккинговые ботинки', 'Дождевик', 'Термос'],
    pickup_type: 'hotel_pickup',
  };
  it('TRUE — «Группа не ограничена (одна заявка …)», «Группа до 12» нет', () => {
    const r = composeTourDescription({ ...facts, group_size_unlimited: true });
    expect(r.text).toContain(UNLIMITED_12);
    expect(r.text).not.toContain('Группа до 12');
    expect(r.used).toContain('group_size_unlimited');
  });
  it('FALSE — прежнее «Группа до 12 человек.»', () => {
    const r = composeTourDescription({ ...facts, group_size_unlimited: false });
    expect(r.text).toContain('Группа до 12 человек.');
    expect(r.used).toContain('max_participants');
  });
});

const DETAILS_ROW = {
  id: 77, title: 'Курильское озеро на внедорожнике, 3 дня', base_price: 95000, price_unit: 'per_person',
  short_description: null, description: null, meeting_point: null, included: null, not_included: null,
  what_to_bring: null, cancellation_policy: null, location_name: 'Курильское озеро', activity_type: 'jeep',
  program: null, safety_notes: null, pickup_type: null, pickup_details: null,
  max_participants: 12, operator_name: 'Андрей Запорожец', operator_legal_name: null, operator_inn: null, operator_ogrn: null,
};

describe('Кузьмич и MCP get_tour_details', () => {
  it('TRUE — агент слышит «не ограничена» и потолок одной заявки', async () => {
    query.mockResolvedValue({ rows: [{ ...DETAILS_ROW, group_size_unlimited: true }] });
    const out = await getTourDetails('Курильское');
    expect(query.mock.calls[1][0]).toContain('group_size_unlimited');
    expect(out).toContain(UNLIMITED_12);
    expect(out).not.toContain('Группа до 12');
  });
  it('FALSE — «Группа до 12 человек.»', async () => {
    query.mockResolvedValue({ rows: [{ ...DETAILS_ROW, group_size_unlimited: false }] });
    const out = await getTourDetails('Курильское');
    expect(out).toContain('Группа до 12 человек.');
    expect(out).not.toContain('не ограничена');
  });
});

const FETCH_ROW = {
  id: '78', title: 'Морская прогулка в бухту Русскую', slug: 'zaporozhets-bukhta-russkaya', short_description: null, description: null,
  base_price: '14000.00', currency: 'RUB', price_unit: 'per_person', duration_hours: '10.5', duration_type: 'day', multi_day_count: null,
  difficulty: 'easy', season_start: null, season_end: null, location_name: 'Бухта Русская', included: null, not_included: null,
  what_to_bring: null, safety_notes: null, program: null, price_note: null, cancellation_policy: null, max_participants: 10,
  operator_name: 'Андрей Запорожец',
};

describe('MCP fetch tour:', () => {
  it('TRUE — «Группа не ограничена (одна заявка на сайте — до 10 человек).»', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...FETCH_ROW, group_size_unlimited: true }] });
    const doc = await fetchDocument('tour:78', 'https://vedarai.ru');
    expect(query.mock.calls[0][0]).toContain('ot.group_size_unlimited');
    expect(doc.text).toContain('Группа не ограничена (одна заявка на сайте — до 10 человек).');
  });
  it('FALSE — «Группа до 10 человек.»', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...FETCH_ROW, group_size_unlimited: false }] });
    const doc = await fetchDocument('tour:78', 'https://vedarai.ru');
    expect(doc.text).toContain('Группа до 10 человек.');
    expect(doc.text).not.toContain('не ограничена');
  });
});

describe('пост канала и фид Яндекса', () => {
  const post = {
    id: '77', slug: 'zaporozhets-kurilskoe-ozero-3-dnya', title: 'Курильское озеро', short_description: null,
    base_price: 95000, price_unit: 'per_person', duration_hours: null, multi_day_count: 3, max_participants: 12,
    difficulty: null, activity_type: 'jeep', location: 'Курильское озеро', photos: null, operator_name: 'Андрей Запорожец',
  };
  it('пост: TRUE — «группа не ограничена», FALSE — «до 12 чел.»', () => {
    const on = buildTourPostText({ ...post, group_size_unlimited: true }, 'https://vedarai.ru');
    expect(on).toContain('группа не ограничена');
    expect(on).not.toContain('до 12 чел.');
    expect(buildTourPostText({ ...post, group_size_unlimited: false }, 'https://vedarai.ru')).toContain('до 12 чел.');
  });

  const channelTour: ChannelTour = {
    id: 77, slug: 'zaporozhets-kurilskoe-ozero-3-dnya', title: 'Курильское озеро', description: 'Медведи и нерка.',
    short_description: null, activity_type: 'jeep', location_name: 'Курильское озеро', latitude: null, longitude: null,
    base_price: 95000, max_participants: 12, duration_hours: 72, difficulty: null, photos: [], included: [],
    season_start: null, season_end: null,
    tripster_experience_id: null, avito_listing_id: null, sputnik8_product_id: null,
  };
  it('фид Яндекса: TRUE — «не ограничен» в параметре и «не ограничена» в описании', () => {
    const xml = generateYandexYmlFeed([{ ...channelTour, group_size_unlimited: true }]);
    expect(xml).toContain('<param name="Размер группы">не ограничен</param>');
    expect(xml).toContain(UNLIMITED_12);
    expect(xml).not.toContain('Группа до 12');
  });
  it('фид Яндекса: FALSE — «до 12 чел.»', () => {
    const xml = generateYandexYmlFeed([{ ...channelTour, group_size_unlimited: false }]);
    expect(xml).toContain('<param name="Размер группы">до 12 чел.</param>');
    expect(xml).toContain('Группа до 12 человек.');
  });
});
