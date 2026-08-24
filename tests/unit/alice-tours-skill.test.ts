/**
 * Навык Алисы «Туры Камчатки» — чистая логика диалога, без БД.
 *
 * Три свойства держит этот файл: список честен про пустой каталог (§4.0),
 * пагинация не выдумывает шестой тур, и деталь тура никогда не произносит
 * точку сбора/бронирование — это граница канала (шапка lib/alice/tours-skill.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { handleAliceTours, type FetchTours } from '@/lib/alice/tours-skill';
import type { AliceRequest } from '@/lib/alice/types';
import type { MarketplaceTourRow, MarketplaceToursResult } from '@/lib/search/tour-search';

function row(overrides: Partial<MarketplaceTourRow> = {}): MarketplaceTourRow {
  return {
    id: 1,
    title: 'Восхождение на Авачинский',
    description: 'Однодневный поход на вершину действующего вулкана с гидом.',
    short_description: null,
    base_price: 8500,
    price_old: null,
    price_unit: 'за человека',
    activity_type: 'trekking',
    location_type: 'volcano',
    location_name: 'Авачинский вулкан',
    tour_image: null,
    max_participants: 12,
    duration_hours: 10,
    duration_type: 'day',
    multi_day_count: null,
    difficulty: 'medium',
    included: null,
    season_start: null,
    season_end: null,
    operator_name: 'Тестовый оператор',
    operator_id: 'op-1',
    bookings_count: 0,
    has_availability: true,
    ...overrides,
  };
}

function simpleUtterance(command: string, state?: Record<string, unknown>): AliceRequest {
  return {
    meta: { locale: 'ru-RU', timezone: 'Asia/Kamchatka', client_id: 'test' },
    request: { command, original_utterance: command, type: 'SimpleUtterance', nlu: { tokens: command.split(' '), entities: [] } },
    session: { message_id: 0, session_id: 's1', skill_id: 'skill1', user_id: 'u1', application: { application_id: 'a1' }, new: !state },
    state: state ? { session: state } : undefined,
    version: '1.0',
  };
}

function buttonPressed(payload: unknown, state?: Record<string, unknown>): AliceRequest {
  return {
    meta: { locale: 'ru-RU', timezone: 'Asia/Kamchatka', client_id: 'test' },
    request: { command: '', original_utterance: '', type: 'ButtonPressed', payload },
    session: { message_id: 1, session_id: 's1', skill_id: 'skill1', user_id: 'u1', application: { application_id: 'a1' }, new: false },
    state: state ? { session: state } : undefined,
    version: '1.0',
  };
}

const fakeResult = (tours: MarketplaceTourRow[], total: number): MarketplaceToursResult => ({ tours, total });

describe('пустой каталог — честный отказ, а не пустой успех', () => {
  it('ноль туров говорится прямо, не выдаётся за список', async () => {
    const fetchTours: FetchTours = vi.fn(async () => fakeResult([], 0));
    const res = await handleAliceTours(simpleUtterance('какие есть туры'), fetchTours);
    expect(res.response.text).toMatch(/пока ни один тур не опубликован/i);
    expect(res.response.end_session).toBe(false);
  });
});

describe('список туров', () => {
  it('новая сессия без слов сразу получает список', async () => {
    const tours = [row({ id: 1, title: 'Тур А' }), row({ id: 2, title: 'Тур Б' })];
    const fetchTours: FetchTours = vi.fn(async () => fakeResult(tours, 2));
    const res = await handleAliceTours(simpleUtterance(''), fetchTours);
    expect(res.response.text).toContain('Тур А');
    expect(res.response.text).toContain('Тур Б');
    expect(res.response.buttons).toHaveLength(2);
    expect(res.session_state).toMatchObject({ v: 1, total: 2 });
  });

  it('«ещё» продолжает с offset из состояния, не с нуля', async () => {
    const fetchTours: FetchTours = vi.fn(async (filters) => {
      expect(filters.offset).toBe(5);
      return fakeResult([row({ id: 6, title: 'Тур Ж' })], 6);
    });
    const state = { v: 1, items: [{ id: 1, title: 'Тур А' }], offset: 5, sort: 'recommended', total: 6 };
    const res = await handleAliceTours(simpleUtterance('ещё', state), fetchTours);
    expect(res.response.text).toContain('Тур Ж');
  });

  it('пагинация за пределами total не выдумывает шестой тур', async () => {
    const fetchTours: FetchTours = vi.fn(async () => fakeResult([], 5));
    const state = { v: 1, items: [{ id: 1, title: 'Тур А' }], offset: 5, sort: 'recommended', total: 5 };
    const res = await handleAliceTours(simpleUtterance('ещё', state), fetchTours);
    expect(res.response.text).toMatch(/это все туры/i);
    expect(res.response.text).not.toMatch(/\d+\)/); // ни одной пронумерованной строки
  });

  it('«подешевле» пересобирает список с сортировкой по цене, с нуля', async () => {
    const fetchTours: FetchTours = vi.fn(async (filters) => {
      expect(filters.sort).toBe('price_asc');
      expect(filters.offset).toBe(0);
      return fakeResult([row()], 1);
    });
    const state = { v: 1, items: [{ id: 1, title: 'Тур А' }], offset: 5, sort: 'recommended', total: 9 };
    await handleAliceTours(simpleUtterance('а подешевле есть?', state), fetchTours);
    expect(fetchTours).toHaveBeenCalled();
  });
});

describe('деталь тура — граница канала', () => {
  it('по номеру из показанного списка находит тот же тур', async () => {
    const state = { v: 1, items: [{ id: 1, title: 'Тур А' }, { id: 2, title: 'Тур Б' }], offset: 2, sort: 'recommended', total: 2 };
    const fetchTours: FetchTours = vi.fn(async (filters) => {
      expect(filters.id).toBe(2);
      return fakeResult([row({ id: 2, title: 'Тур Б', description: 'Полное описание тура Б.' })], 1);
    });
    const res = await handleAliceTours(simpleUtterance('второй', state), fetchTours);
    expect(res.response.text).toContain('Тур Б');
    expect(res.response.text).toContain('Полное описание тура Б.');
  });

  it('не придумывает точку сбора — отсылает за деталями на сайт, а не даёт её сама', async () => {
    const state = { v: 1, items: [{ id: 1, title: 'Тур А' }], offset: 1, sort: 'recommended', total: 1 };
    const fetchTours: FetchTours = vi.fn(async () => fakeResult([row()], 1));
    const res = await handleAliceTours(simpleUtterance('первый', state), fetchTours);
    // Упомянуть словами «эти детали — на сайте» можно, СКАЗАТЬ саму точку сбора нельзя:
    // MarketplaceTourRow меть не носит meeting_point вовсе — придумать его неоткуда.
    expect(res.response.text).toMatch(/точные детали.*сайте/i);
    expect(res.response.text).not.toMatch(/встречаемся (у|в|на)|координаты встречи/i);
  });

  it('пустое описание не выдумывается — честная фраза вместо текста', async () => {
    const state = { v: 1, items: [{ id: 1, title: 'Тур А' }], offset: 1, sort: 'recommended', total: 1 };
    const fetchTours: FetchTours = vi.fn(async () => fakeResult([row({ description: '', short_description: null })], 1));
    const res = await handleAliceTours(simpleUtterance('первый', state), fetchTours);
    expect(res.response.text).toMatch(/подробного описания пока нет/i);
  });

  it('кнопка «details» с payload находит тот же тур, что и голосовой номер', async () => {
    const state = { v: 1, items: [{ id: 7, title: 'Тур Семь' }], offset: 1, sort: 'recommended', total: 1 };
    const fetchTours: FetchTours = vi.fn(async (filters) => {
      expect(filters.id).toBe(7);
      return fakeResult([row({ id: 7, title: 'Тур Семь' })], 1);
    });
    const res = await handleAliceTours(buttonPressed({ action: 'details', id: 7 }, state), fetchTours);
    expect(res.response.text).toContain('Тур Семь');
  });

  it('тур снят с публикации между показом списка и уточнением — честно, не падает', async () => {
    const state = { v: 1, items: [{ id: 1, title: 'Тур А' }], offset: 1, sort: 'recommended', total: 1 };
    const fetchTours: FetchTours = vi.fn(async () => fakeResult([], 0));
    const res = await handleAliceTours(simpleUtterance('первый', state), fetchTours);
    expect(res.response.text).toMatch(/не нашла такой тур/i);
  });
});

describe('прочие ветки диалога', () => {
  it('без состояния номер не разбирается — просит сначала список', async () => {
    const fetchTours: FetchTours = vi.fn(async () => fakeResult([], 0));
    const res = await handleAliceTours(simpleUtterance('второй'), fetchTours);
    expect(fetchTours).not.toHaveBeenCalled();
    expect(res.response.text).toMatch(/сначала спросите список/i);
  });

  it('порядковая цифра (не слово) без состояния — тот же честный отказ', async () => {
    const fetchTours: FetchTours = vi.fn();
    const res = await handleAliceTours(simpleUtterance('3'), fetchTours);
    expect(fetchTours).not.toHaveBeenCalled();
    expect(res.response.text).toMatch(/сначала спросите список/i);
  });

  it('«помощь» не трогает БД вовсе', async () => {
    const fetchTours: FetchTours = vi.fn();
    const res = await handleAliceTours(simpleUtterance('помощь', { v: 1, items: [], offset: 0, sort: 'recommended', total: 0 }), fetchTours);
    expect(fetchTours).not.toHaveBeenCalled();
    expect(res.response.text).toMatch(/какие есть туры/i);
  });

  it('«хватит» завершает сессию', async () => {
    const fetchTours: FetchTours = vi.fn();
    const res = await handleAliceTours(simpleUtterance('хватит', { v: 1, items: [], offset: 0, sort: 'recommended', total: 0 }), fetchTours);
    expect(res.response.end_session).toBe(true);
  });

  it('искажённое состояние (не наша форма) не роняет обработчик', async () => {
    // Состояние не распознаётся Zod-схемой → hasState=false. Берём команду,
    // которая НЕ порядковое слово (иначе это уже другой, отдельно проверенный
    // случай «need_list_first») — свободный текст на пустом состоянии тоже не
    // угадывается, а честно просит список, не пытаясь искать вслепую.
    const fetchTours: FetchTours = vi.fn();
    const res = await handleAliceTours(simpleUtterance('сплав', { garbage: true } as unknown as Record<string, unknown>), fetchTours);
    expect(fetchTours).not.toHaveBeenCalled();
    expect(res.response.text).not.toMatch(/^\s*$/);
  });

  it('свободный текст без совпадений с ключевыми словами ищет тур по названию', async () => {
    // Два вызова: сперва поиск по тексту находит кандидата, затем уточняющий
    // запрос по id — тот же путь, что и у выбора по номеру/кнопке.
    const fetchTours: FetchTours = vi.fn(async (filters) => {
      if ('search' in filters) return fakeResult([row({ id: 9, title: 'Сплав по реке Быстрая' })], 1);
      if ('id' in filters) return fakeResult([row({ id: 9, title: 'Сплав по реке Быстрая' })], 1);
      throw new Error(`неожиданный вызов: ${JSON.stringify(filters)}`);
    });
    const res = await handleAliceTours(simpleUtterance('сплав по быстрой', { v: 1, items: [{ id: 1, title: 'X' }], offset: 1, sort: 'recommended', total: 1 }), fetchTours);
    expect(fetchTours).toHaveBeenNthCalledWith(1, expect.objectContaining({ search: 'сплав по быстрой' }));
    expect(res.response.text).toContain('Сплав по реке Быстрая');
  });
});
