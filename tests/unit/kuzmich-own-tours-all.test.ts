/**
 * 04.11: у гида 13 туров одной миграцией, LIMIT 10 по created_at отрезал
 * «Вачкажец + Озёрки» — помощник его «не видел». Теперь читаются все (до 100),
 * а тур находится по словам: ё → е, «+» и союзы не мешают.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
const avail = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/planner', () => ({ createPlannerCache: () => new Map(), fetchAvailabilityForTour: (...a: unknown[]) => avail(...a) }));

const { runMyToursSchedule } = await import('@/lib/kuzmich/operator-tours-tool');
const { tourTitleMatchesQuery } = await import('@/lib/operators/chat-dates/parse');

const TITLES = [
  'Восхождение на Авачинский вулкан', 'Авачинский перевал и гора Верблюд', 'Бухта Русская', 'Дачные источники: спокойный маршрут',
  'Ганальские Востряки', 'Каньон Опасный и Дачные', 'Курильское озеро, 3 дня', 'Курильское озеро, 4 дня', 'Толбачик, 4 дня',
  'Толмачёво', 'Вачкажец + Озёрки', 'Гора Верблюд и пляж', 'Вулкан Горелый',
];
const rows = TITLES.map((title, i) => ({
  id: 64 + i, title, slug: `t-${64 + i}`, is_active: true, is_published: i !== 2,
  max_participants: 8, season_start: null, season_end: null,
}));
const NOW = Date.parse('2026-11-04T00:00:00Z');

describe('свои туры помощника: все, а не 10; поиск словами', () => {
  beforeEach(() => { query.mockReset(); avail.mockReset(); avail.mockResolvedValue([]); });

  it.each(['Вачкажец + озёрки', 'вачкажец озерки', 'Вачкажец и Озерки', 'вачкажец'])('«%s» находит старый тур среди 13', async (q) => {
    query.mockResolvedValue({ rows });
    const out = await runMyToursSchedule('g1', { tour: q }, NOW);
    expect(out).toContain('«Вачкажец + Озёрки»');
    expect(out).not.toContain('Горелый');
    expect(out).toMatch(/ссылка https?:\/\/\S+\/catalog\/tours\/t-74/);
  });

  it('SQL без фильтра по названию и с LIMIT 100; без запроса — все 13, даты только по 10', async () => {
    query.mockResolvedValue({ rows });
    const out = await runMyToursSchedule('g1', {}, NOW);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/LIMIT 100/);
    expect(sql).not.toMatch(/ILIKE/);
    for (const t of TITLES) expect(out).toContain(`«${t}»`);
    expect(avail).toHaveBeenCalledTimes(10);
  });

  it('не нашёл — называет все свои туры, а не «туров нет»', async () => {
    query.mockResolvedValue({ rows });
    const out = await runMyToursSchedule('g1', { tour: 'Мутновский' }, NOW);
    expect(out).toContain('нет подходящего под «Мутновский»');
    expect(out).toContain('ID74 «Вачкажец + Озёрки»');
  });

  it('номер тура и скрытый тур без ссылки', async () => {
    query.mockResolvedValue({ rows });
    const out = await runMyToursSchedule('g1', { tour: '66' }, NOW);
    expect(out).toContain('«Бухта Русская»');
    expect(out).not.toContain('ссылка');
  });

  it('сопоставление: окончания, ё, лишние слова не дают ложного совпадения', () => {
    expect(tourTitleMatchesQuery('курильское озеро 4', 'Курильское озеро, 4 дня')).toBe(true);
    expect(tourTitleMatchesQuery('толмачево', 'Толмачёво')).toBe(true);
    expect(tourTitleMatchesQuery('вачкажец горелый', 'Вачкажец + Озёрки')).toBe(false);
    expect(tourTitleMatchesQuery('+', 'Вачкажец + Озёрки')).toBe(false);
  });
});
