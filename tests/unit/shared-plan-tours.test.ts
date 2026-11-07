/**
 * Что читает страница по ссылке (/trip/[token]) из плана: тур дня — тот, что
 * поставил план, и у опубликованной поездки, и у черновика; сколько человек в
 * группе — для сверки мест, наружу не отдаётся (аудит планировщика 07.11,
 * волна 2.6: H13, H14). Ответ share-API — tests/unit/trip-share-saved-tour.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn(), loadDraft: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('@/lib/planner/plan-drafts', () => ({ loadDraft: m.loadDraft }));

import { readSharedPlan } from '@/lib/trips/shared-plan';

const TOKEN = '00000000-0000-4000-8000-000000000613';
const day = (n: number, tourId?: string) => ({
  day: n, type: 'activity', zone: 'avachinsky', title: `День ${n}`, activityType: 'volcano',
  ...(tourId ? { realTour: { tourId, lodgingIncluded: null } } : {}),
});

beforeEach(() => { m.query.mockReset(); m.loadDraft.mockReset(); });

describe('опубликованная поездка', () => {
  it('тур дня — сохранённый, как у черновика; группа — из состава', async () => {
    m.query.mockResolvedValue({ rows: [{
      id: 't1', title: 'Маршрут', arrival_date: '2030-08-01', departure_date: '2030-08-03', places: [], activities: [],
      days: [day(1), day(2, '70'), day(3, '5')], transport_by_day: {}, party: { adults: 2, children: [6], budgetTier: 'comfort' },
    }] });
    const read = await readSharedPlan(TOKEN);
    expect(read.kind).toBe('found');
    const plan = read.kind === 'found' ? read.plan : null;
    expect(plan).toMatchObject({ source: 'trip', day_tour_ids: { 2: '70', 3: '5' }, people: 3 });
    expect(plan).not.toHaveProperty('party');
    expect(m.query.mock.calls[0]![0]).toMatch(/SELECT [^;]*\bparty\b[^;]*FROM user_trips/);
  });

  it('поездка до 09.10 — без туров и без состава: пусто и «не записано»', async () => {
    m.query.mockResolvedValue({ rows: [{
      id: 't1', title: 'Маршрут', arrival_date: null, departure_date: null, places: [], activities: [],
      days: [day(1), day(2)], transport_by_day: {}, party: null,
    }] });
    const read = await readSharedPlan(TOKEN);
    expect(read.kind === 'found' && read.plan).toMatchObject({ day_tour_ids: {}, people: null });
  });
});

describe('черновик Кузьмича или MCP', () => {
  it('тур дня — из плана, группа — из параметров', async () => {
    m.query.mockResolvedValue({ rows: [] });
    m.loadDraft.mockResolvedValue({ kind: 'found', draft: {
      id: TOKEN, params: { arrivalDate: '2030-08-01', departureDate: '2030-08-02', adults: 3, children: [], interests: ['volcano'] },
      days: [day(1, '9'), day(2)], expiresAt: '2030-07-08T00:00:00.000Z',
    } });
    const read = await readSharedPlan(TOKEN);
    expect(read.kind === 'found' && read.plan).toMatchObject({ source: 'draft', day_tour_ids: { 1: '9' }, people: 3 });
  });
});
