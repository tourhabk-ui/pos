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
  BOOKING_FORM_MAX_PARTICIPANTS, bookingRequestCeiling, groupRangeShort, groupSentence, groupSentenceIfUnlimited, groupShort,
  groupStripValue, isGroupSizeUnlimited,
} from '@/lib/tours/group-size';
import { composeTourDescription } from '@/lib/tours/describe';
import { getTourDetails } from '@/lib/kuzmich/core';
import { fetchDocument } from '@/lib/mcp/connector-tools';
import { buildTourPostText } from '@/lib/notifications/tour-channel-post';
import { generateYandexYmlFeed } from '@/lib/channels/yandex';
import { generateAvitoXmlFeed } from '@/lib/channels/avito';
import { getTouristTools } from '@/lib/agents/sdk/tourist-tools';
import { GET as toursFeed } from '@/app/api/tours-feed/route';
import { GET as availabilityDay } from '@/app/api/availability/day/route';
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
      // Поверхности, молчавшие о группе до 1341, называют её только при TRUE.
      expect(groupSentenceIfUnlimited({ max_participants: 15, group_size_unlimited: flag })).toBeNull();
    }
    expect(groupSentenceIfUnlimited({ max_participants: 12, group_size_unlimited: true })).toBe(UNLIMITED_12);
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
  it('FALSE — о группе молчит, как до 1341: число бывает заглушкой автора миграции (1176), §4.0', async () => {
    query.mockResolvedValue({ rows: [{ ...DETAILS_ROW, max_participants: 15, group_size_unlimited: false }] });
    const out = await getTourDetails('Курильское');
    expect(out).not.toMatch(/Группа/);
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
  it('FALSE — о группе молчит, как до 1341 (число не выдаётся агенту фактом)', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...FETCH_ROW, max_participants: 15, group_size_unlimited: false }] });
    const doc = await fetchDocument('tour:78', 'https://vedarai.ru');
    expect(doc.text).not.toMatch(/Группа/);
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

describe('SDK-инструменты агента: search_tours и get_tour_details', () => {
  const tools = getTouristTools(null);
  const run = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.find((t) => t.name === name)!;
    return JSON.parse(await tool.execute(args)) as Record<string, unknown>;
  };
  const ROW = {
    id: 77, slug: 'zaporozhets-kurilskoe-ozero-3-dnya', title: 'Курильское озеро', description: null, base_price: 95000,
    activity_type: 'jeep', duration_days: 3, difficulty: 'easy', location_name: 'Курильское озеро', included: null,
    not_included: null, what_to_bring: null, min_participants: 1, max_participants: 12, available_slots: null,
    next_available_date: null, season_start: null, season_end: null, tour_image: null, operator_name: 'Андрей Запорожец',
    operator_phone: null, avg_rating: null, review_count: 0,
  };

  it('get_tour_details: TRUE — «Группа не ограничена (одна заявка …)», FALSE — прежний диапазон', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...ROW, group_size_unlimited: true }] });
    expect((await run('get_tour_details', { tour_id: '77' })).group)
      .toBe('Группа не ограничена (одна заявка на сайте — до 12 человек)');
    expect(String(query.mock.calls[0][0])).toContain('t.group_size_unlimited');
    query.mockResolvedValueOnce({ rows: [{ ...ROW, group_size_unlimited: false }] });
    expect((await run('get_tour_details', { tour_id: '77' })).group).toBe('1-12 чел.');
  });

  it('search_tours: строка каталога называет группу тем же правилом', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...ROW, group_size_unlimited: true }, { ...ROW, id: 79, group_size_unlimited: false }] });
    const out = await run('search_tours', { query: 'Курильское' });
    const groups = (out.tours as Array<{ group: string }>).map((t) => t.group);
    expect(groups).toEqual(['Группа не ограничена (одна заявка на сайте — до 12 человек)', '1-12 чел.']);
  });
});

describe('фид Авито и экспорт /api/tours-feed', () => {
  const avitoTour: ChannelTour = {
    id: 78, slug: 'zaporozhets-bukhta-russkaya', title: 'Морская прогулка в бухту Русскую', description: 'Бухта, птичьи базары.',
    short_description: null, activity_type: 'boat_trip', location_name: 'Бухта Русская', latitude: null, longitude: null,
    base_price: 14000, max_participants: 10, duration_hours: 10.5, difficulty: null, photos: [], included: [],
    season_start: null, season_end: null,
    tripster_experience_id: null, avito_listing_id: null, sputnik8_product_id: null,
  };
  it('Авито: TRUE — «не ограничено», FALSE — «до 10 чел.»', () => {
    expect(generateAvitoXmlFeed([{ ...avitoTour, group_size_unlimited: true }]).xml)
      .toContain('name="Количество участников">не ограничено<');
    expect(generateAvitoXmlFeed([{ ...avitoTour, group_size_unlimited: false }]).xml)
      .toContain('name="Количество участников">до 10 чел.<');
  });

  it('экспорт для площадок: признак полем group.unlimited, max — потолок заявки', async () => {
    const row = {
      id: '78', name: 'Морская прогулка', description: '', price: '14000', duration: 10.5, difficulty: 'easy',
      category: 'boat_trip', max_group_size: 10, min_group_size: 1, op_name: 'Андрей Запорожец', op_slug: 'zaporozhets',
      op_phone: null, op_email: null,
    };
    query.mockResolvedValueOnce({ rows: [{ ...row, group_size_unlimited: true }, { ...row, id: '79', group_size_unlimited: false }] });
    const res = await toursFeed(new Request('http://localhost/api/tours-feed') as never);
    const body = await res.json() as { tours: Array<{ group: { min: number; max: number; unlimited: boolean } }> };
    expect(String(query.mock.calls[0][0])).toContain('t.group_size_unlimited');
    expect(body.tours.map((t) => t.group)).toEqual([
      { min: 1, max: 10, unlimited: true },
      { min: 1, max: 10, unlimited: false },
    ]);
  });
});

describe('плашка группы в блоке «Туры по маршруту» (groupRangeShort)', () => {
  it('TRUE — «не ограничена» вместо «1–12»; FALSE — прежние «1–12» и «до 12»', () => {
    expect(groupRangeShort({ min_participants: 1, max_participants: 12, group_size_unlimited: true })).toBe('не ограничена');
    expect(groupRangeShort({ min_participants: 1, max_participants: 12, group_size_unlimited: false })).toBe('1–12');
    expect(groupRangeShort({ min_participants: null, max_participants: 12 })).toBe('до 12');
    expect(groupRangeShort({ min_participants: null, max_participants: null })).toBeNull();
  });
});

describe('/api/availability/day — модалка брони /calendar получает признак', () => {
  it('t.group_size_unlimited в выборке и groupSizeUnlimited в ответе; NULL — FALSE', async () => {
    const row = {
      tour_id: '77', title: 'Курильское озеро, 3 дня', description: null, activity_type: 'jeep', location_name: null,
      base_price: '95000', price_override: null, price_unit: 'per_person', duration_hours: '72', duration_type: 'multi_day',
      max_participants: 12, min_participants: 1, available_slots: 12, booked_slots: 0, free_slots: 12,
      weather_status: 'ok', operator_id: 'p-77', operator_name: 'Андрей Запорожец', operator_verified: false,
      operator_slug: null, operator_public: null, operator_rating: null, tags: [],
    };
    query.mockResolvedValueOnce({ rows: [{ ...row, group_size_unlimited: true }, { ...row, tour_id: '79', group_size_unlimited: null }] });
    const res = await availabilityDay(new Request('http://localhost/api/availability/day?date=2099-07-19') as never);
    const body = await res.json() as { tours: Array<{ groupSizeUnlimited: boolean }> };
    expect(String(query.mock.calls[0][0])).toContain('t.group_size_unlimited');
    expect(body.tours.map((t) => t.groupSizeUnlimited)).toEqual([true, false]);
  });
});
