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

  it('ищет активный тур по названию/ключевому слову, точное совпадение названия первым', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await getTourDetails('сплав');
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('FROM operator_tours');
    expect(sql).toContain('is_active = true');
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('meeting_point');
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
    expect(out).toContain('СПЛАВ ПО РЕКЕ БЫСТРАЯ');
    expect(out).toContain('147-й км трассы А4');
    expect(out).toContain('139-й км трассы А4');
    expect(out).toContain('бери ТОЛЬКО отсюда');
    expect(out).toContain('Трансфер туда и обратно');
    expect(out).toContain('Купальник');
    expect(out).toContain('13 000');
  });
});
