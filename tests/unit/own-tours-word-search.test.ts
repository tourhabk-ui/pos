/**
 * Свой тур — словами названия, а не целой фразой (перенесено из #3039).
 *
 * Гид спросил помощника про тур «Вачкажец + озёрки». Поиск шёл ILIKE целой
 * фразой: «вачкажец озерки» (без «+», с «е» вместо «ё») не находил
 * «Вачкажец + Озёрки», и помощник отвечал «нет подходящего» при живом туре.
 * Теперь каждое слово запроса ищется в названии с теми же правилами
 * окончаний, что у matchTours; не нашлось — помощник получает список своих
 * туров с номерами и уточняет у гида.
 *
 * Сторож — вызов правила и самого инструмента.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
const avail = vi.fn();
vi.mock('@/lib/planner', () => ({ createPlannerCache: () => new Map(), fetchAvailabilityForTour: (...a: unknown[]) => avail(...a) }));

import { tourTitleMatchesQuery } from '@/lib/operators/chat-dates/parse';
import { runMyToursSchedule } from '@/lib/kuzmich/operator-tours-tool';

const NOW = Date.parse('2026-11-05T00:00:00Z');
const PARTNER = '11111111-1111-1111-1111-111111111111';

const TITLES = [
  'Ганальские Востряки', 'Авачинский перевал, Верблюд', 'Толмачёво + купание', 'Вачкажец + озёрки',
  'Горелый', 'Мутновский', 'Вилючик', 'Козельский', 'Авачинский', 'Камень Верблюд',
  'Халактырский пляж', 'Налычево', 'Паратунка',
];

function rows() {
  return TITLES.map((title, i) => ({
    id: i + 1, title, is_active: true, is_published: true, max_participants: 6,
    season_start: null, season_end: null, total_count: String(TITLES.length), nearest_free: null,
  }));
}

beforeEach(() => {
  query.mockReset();
  avail.mockReset();
  avail.mockResolvedValue([]);
  query.mockResolvedValue({ rows: rows() });
});

describe('tourTitleMatchesQuery', () => {
  it('слова запроса — в названии: ё и е, знаки, союзы не мешают', () => {
    for (const q of ['вачкажец озерки', 'Вачкажец + озёрки', 'Вачкажец и Озерки', 'вачкажец', 'тур на Вачкажец']) {
      expect(tourTitleMatchesQuery(q, 'Вачкажец + озёрки')).toBe(true);
    }
  });

  it('чужое слово — не совпадение; пустой запрос — не совпадение', () => {
    expect(tourTitleMatchesQuery('вачкажец горелый', 'Вачкажец + озёрки')).toBe(false);
    expect(tourTitleMatchesQuery('Мутновский', 'Вачкажец + озёрки')).toBe(false);
    expect(tourTitleMatchesQuery('и на', 'Вачкажец + озёрки')).toBe(false);
  });
});

describe('my_tours_schedule: поиск своего тура', () => {
  it('«вачкажец озерки» находит «Вачкажец + озёрки», и только его', async () => {
    const out = await runMyToursSchedule(PARTNER, { tour: 'вачкажец озерки' }, NOW);
    expect(out).toContain('ID4 «Вачкажец + озёрки»');
    expect(out).not.toMatch(/Горелый|Мутновский|Паратунка/);
    expect(out).not.toMatch(/нет подходящего/);
  });

  it('номер тура тоже работает: «4» и «ID4»', async () => {
    for (const tour of ['4', 'ID4']) {
      const out = await runMyToursSchedule(PARTNER, { tour }, NOW);
      expect(out).toContain('ID4 «Вачкажец + озёрки»');
      expect(out).not.toContain('Горелый');
    }
  });

  it('не нашлось — список своих туров с номерами, а не голое «нет»', async () => {
    const out = await runMyToursSchedule(PARTNER, { tour: 'Толбачик' }, NOW);
    expect(out).toMatch(/Среди своих туров нет подходящего под «Толбачик»/);
    for (const [i, t] of TITLES.entries()) expect(out).toContain(`ID${i + 1} «${t}»`);
    expect(out).toMatch(/Уточни у партнёра/);
  });

  it('с запросом читаются все свои туры, без фильтра в SQL; без запроса — прежний предел', async () => {
    await runMyToursSchedule(PARTNER, { tour: 'вачкажец' }, NOW);
    const [withQ, paramsQ] = query.mock.calls[0];
    expect(paramsQ).toEqual([PARTNER]);
    expect(String(withQ)).not.toMatch(/ILIKE/);
    const limitQ = Number([...String(withQ).matchAll(/LIMIT (\d+)/g)].pop()?.[1]);
    expect(limitQ).toBeGreaterThanOrEqual(100);

    query.mockClear();
    await runMyToursSchedule(PARTNER, {}, NOW);
    const limitAll = Number([...String(query.mock.calls[0][0]).matchAll(/LIMIT (\d+)/g)].pop()?.[1]);
    expect(limitAll).toBe(30);
  });

  it('прочитаны не все свои туры — так и сказано, «нет» не утверждается', async () => {
    query.mockResolvedValue({ rows: rows().map((r) => ({ ...r, total_count: '250' })) });
    const out = await runMyToursSchedule(PARTNER, { tour: 'Толбачик' }, NOW);
    expect(out).toMatch(/прочитаны не все \(13 из 250\) — не утверждай, что тура нет/);
  });
});
