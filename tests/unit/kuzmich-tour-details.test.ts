/**
 * tests/unit/kuzmich-tour-details.test.ts
 *
 * Инструмент Кузьмича get_tour_details: полная карточка ОДНОГО тура —
 * описание, программа, точка сбора/логистика, состав, что взять. Общий
 * get_tours эти поля не отдаёт, поэтому раньше Кузьмич не знал ни программы
 * сплава, ни откуда он стартует. Сторож фиксирует, что детали доходят из БД
 * (а не выдумываются) и что точка сбора помечена «бери только отсюда».
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
  transaction: vi.fn(),
}));

import { getTourDetails } from '@/lib/kuzmich/core';

beforeEach(() => poolQueryMock.mockReset());

describe('getTourDetails', () => {
  it('пустой запрос → пусто, БД не трогаем', async () => {
    const out = await getTourDetails('   ');
    expect(out).toBe('');
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('резолвит тур ОБЩИМ правилом (resolveTourByQuery): активные, точное совпадение первым', async () => {
    // После v2 handoff (#60) резолв у get_tour_details, get_tour_availability
    // и handoff-ссылок один — иначе «детали» и «даты» отвечали бы про разные
    // туры. Первый запрос — резолвер, детали уходят вторым запросом по id.
    poolQueryMock.mockResolvedValue({ rows: [] });
    await getTourDetails('сплав');
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('FROM operator_tours');
    expect(sql).toContain('is_active = true');
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toMatch(/CASE WHEN title ILIKE \$1 THEN 0/);
    expect(params).toEqual(['%сплав%']);
  });

  it('тур не найден → честно говорит «не найден», без выдумок', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const out = await getTourDetails('несуществующий тур');
    expect(out).toContain('не найден');
    expect(out.toLowerCase()).toContain('не выдумывай');
  });

  it('отдаёт описание, точку сбора и состав; логистику помечает «бери только отсюда»', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{
      id: 42,
      title: 'Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ',
      base_price: 13000,
      short_description: 'Сплав с ухой и рыбалкой',
      description: 'Полное описание сплава по реке Быстрой.',
      meeting_point: 'Старт сплава — 147-й км трассы А4.\nСтоянка и забор трансфера — 139-й км трассы А4.',
      included: ['Трансфер туда и обратно', 'Питание'],
      not_included: ['Личные расходы'],
      what_to_bring: ['Купальник', 'Ветровка'],
      location_name: 'река Быстрая',
      activity_type: 'rafting',
    }] });
    const out = await getTourDetails('Быстрая');
    // Второй запрос — детали (включая точку сбора) строго по id резолва.
    const [sql2, params2] = poolQueryMock.mock.calls[1];
    expect(sql2).toContain('meeting_point');
    expect(params2).toEqual([42]);
    expect(out).toContain('СПЛАВ ПО РЕКЕ БЫСТРАЯ');
    expect(out).toContain('147-й км трассы А4');
    expect(out).toContain('139-й км трассы А4');
    expect(out).toContain('бери ТОЛЬКО отсюда');
    expect(out).toContain('Трансфер туда и обратно');
    expect(out).toContain('Купальник');
    expect(out).toContain('13 000');
  });
});

// Проверка MCP 29.09: описание инструмента обещало программу, забор и
// правила безопасности, а SELECT их не брал; резолвер находил черновики.
describe('getTourDetails: программа, забор, безопасность — и только тур на витрине', () => {
  const TOUR = {
    id: 27, title: 'Сплав по реке Быстрая', base_price: 13000, price_unit: 'person',
    short_description: null, description: 'x'.repeat(1300), meeting_point: null,
    included: null, not_included: null, what_to_bring: null, cancellation_policy: null,
    location_name: null, activity_type: 'rafting',
    program: [{ title: 'Выезд из Петропавловска', text: 'в 7:00' }, { title: 'Сплав', text: '' }],
    safety_notes: ['Спасжилет на воде обязателен'],
    pickup_type: 'hotel_pickup', pickup_details: 'От гостиниц Петропавловска',
  };

  it('всё обещанное доходит до ответа, обрезка описания названа', async () => {
    poolQueryMock.mockImplementation(async (sql: string) =>
      /LIMIT 1/.test(sql) ? { rows: [{ id: 27, title: TOUR.title, base_price: 13000, price_unit: 'person' }] } : { rows: [TOUR] });
    const out = await getTourDetails('сплав');
    expect(out).toMatch(/Программа \(бери ТОЛЬКО отсюда\):\n1\. Выезд из Петропавловска — в 7:00\n2\. Сплав/);
    expect(out).toMatch(/Оператор забирает туриста сам[\s\S]*От гостиниц Петропавловска/);
    expect(out).toMatch(/Спасжилет на воде обязателен/);
    expect(out).toMatch(/описание длиннее/);
  });

  it('не записано — так и сказано, без выдумки', async () => {
    const bare = { ...TOUR, program: null, safety_notes: null, pickup_type: null, pickup_details: null, description: 'коротко' };
    poolQueryMock.mockImplementation(async (sql: string) =>
      /LIMIT 1/.test(sql) ? { rows: [{ id: 27, title: TOUR.title, base_price: 13000, price_unit: 'person' }] } : { rows: [bare] });
    const out = await getTourDetails('сплав');
    expect(out).toMatch(/Программа по дням у этого тура НЕ ЗАПИСАНА/);
    expect(out).toMatch(/Как туриста доставляют на тур, НЕ ЗАПИСАНО/);
    expect(out).not.toMatch(/описание длиннее/);
  });

  it('каждый запрос к operator_tours несёт шлюз витрины (is_published)', async () => {
    poolQueryMock.mockImplementation(async (sql: string) =>
      /LIMIT 1/.test(sql) ? { rows: [{ id: 27, title: TOUR.title, base_price: 13000, price_unit: 'person' }] } : { rows: [TOUR] });
    await getTourDetails('сплав');
    const tourSql = poolQueryMock.mock.calls.map((c) => c[0]).filter((q) => /FROM operator_tours/.test(q));
    expect(tourSql.length).toBeGreaterThanOrEqual(2);
    for (const q of tourSql) expect(q).toMatch(/is_published = true/);
  });
});
