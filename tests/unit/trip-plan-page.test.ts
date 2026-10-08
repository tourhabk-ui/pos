/**
 * План Кузьмича и MCP — ссылкой на страницу (#2225).
 *
 * До этого план из чата был только текстом: ни карты, ни GPX, ни способа
 * открыть его в поле без сети. Теперь ответ make_trip_plan / edit_trip_plan
 * несёт ссылку /trip/<id плана>, и та же страница, что у опубликованной
 * поездки, открывает черновик — с туром дня, названным в чате, без пожеланий
 * и состава группы, без индексации.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) },
}));

import { planIdLine, planIdFromAnswer } from '@/lib/kuzmich/trip-plan-tool';
import { handoffTargetForTool } from '@/lib/mcp/handoff-targets';
import { isSafeTarget } from '@/lib/mcp/handoff';
import { readSharedPlan, draftTitle } from '@/lib/trips/shared-plan';
import { GET as shareGet } from '@/app/api/trips/share/[token]/route';
import { GET as gpxGet } from '@/app/api/trips/share/[token]/gpx/route';

const ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const EXPIRES = new Date('2026-10-15T10:00:00Z');

const DRAFT_ROW = {
  id: ID,
  params: { interests: ['volcano'], arrivalDate: '2026-01-10', departureDate: '2026-01-12', adults: 2, children: [6], budgetTier: 'comfort' },
  days: [
    { day: 1, type: 'arrival', zone: 'avachinsky', title: 'Прилёт', activityType: '', priceFrom: 0, priceTo: 0, coords: [53.02, 158.65], defaultTransport: 'walking' },
    { day: 2, type: 'activity', zone: 'avachinsky', title: 'Восхождение на Авачинский', activityType: 'volcano', priceFrom: 9000, priceTo: 9000, coords: [53.255, 158.833], defaultTransport: 'jeep', realTour: { tourId: '46', operatorName: 'Край Вулканов' } },
    { day: 3, type: 'departure', zone: 'avachinsky', title: 'Вылет', activityType: '', priceFrom: 0, priceTo: 0, coords: [53.17, 158.45], defaultTransport: 'walking' },
  ],
  revision: 2,
  expires_at: EXPIRES,
};

const TOUR_46 = { id: '46', slug: 'klyuchevskaya', title: 'Восхождение на вулкан Ключевская Сопка', base_price: '320000', operator_name: 'Край Вулканов', weather_dependent: true };

type Scenario = { trip?: Record<string, unknown> | null; draft?: typeof DRAFT_ROW | null; tripFails?: boolean; draftFails?: boolean };

function db(s: Scenario) {
  query.mockImplementation(async (sql: string) => {
    if (/FROM user_trips/.test(sql)) {
      if (s.tripFails) throw Object.assign(new Error('connection terminated'), { code: '57P01' });
      return { rows: s.trip ? [s.trip] : [] };
    }
    if (/FROM trip_plan_drafts/.test(sql)) {
      if (s.draftFails) throw Object.assign(new Error('connection terminated'), { code: '57P01' });
      return { rows: s.draft ? [s.draft] : [] };
    }
    if (/FROM operator_tours ot/.test(sql) && /ANY\(\$1::text\[\]\)/.test(sql)) return { rows: [TOUR_46] };
    return { rows: [] };
  });
}

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { spy.mockRestore(); query.mockReset(); });

describe('ссылка на страницу плана в ответе инструмента', () => {
  it('строка с ID плана несёт адрес его страницы', () => {
    const line = planIdLine(ID, 1);
    expect(line).toContain(`ID плана: ${ID}.`);
    expect(line).toMatch(new RegExp(`https://vedarai\\.ru/trip/${ID}$`));
    expect(planIdLine(ID, 3)).toContain('(правка 2)');
  });

  it('черновика нет — нет и ссылки: страница сказала бы «не найдено»', () => {
    expect(planIdLine(null, 1)).not.toContain('/trip/');
  });

  it('id разбирается обратно ровно из этой строки', () => {
    expect(planIdFromAnswer(`план…\n\n${planIdLine(ID, 1)}`)).toBe(ID);
    expect(planIdFromAnswer(`план…\n\n${planIdLine(ID, 4)}`)).toBe(ID);
    expect(planIdFromAnswer(planIdLine(null, 1))).toBeNull();
  });
});

describe('MCP: «Продолжить в Ведаре» ведёт на этот же план', () => {
  it('make_trip_plan с сохранённым планом — страница плана, а не сборка заново', async () => {
    const t = await handoffTargetForTool('make_trip_plan', { days: '5', interests: 'вулканы' }, `план\n\n${planIdLine(ID, 1)}`);
    expect(t).toEqual({ targetType: 'plan', targetPath: `/trip/${ID}` });
    expect(isSafeTarget(t!)).toBe(true);
  });

  it('черновик не записался — прежний переход в планер', async () => {
    const t = await handoffTargetForTool('make_trip_plan', { days: '5' }, planIdLine(null, 1));
    expect(t?.targetType).toBe('planner');
    expect(t?.targetPath).toMatch(/^\/planner\?days=5/);
  });

  it('edit_trip_plan: правка записана — страница; не удалась — ссылки нет', async () => {
    expect(await handoffTargetForTool('edit_trip_plan', { plan_id: ID }, `Добавил день.\n\n${planIdLine(ID, 2)}`))
      .toEqual({ targetType: 'plan', targetPath: `/trip/${ID}` });
    expect(await handoffTargetForTool('edit_trip_plan', { plan_id: ID }, `План ${ID} не найден: ID неверный или плану больше 7 дней.`))
      .toBeNull();
  });

  it('id из аргумента агента ссылкой не становится', async () => {
    expect(await handoffTargetForTool('edit_trip_plan', { plan_id: ID }, 'Нужен ID плана из ответа make_trip_plan')).toBeNull();
    expect(isSafeTarget({ targetType: 'plan', targetPath: '//evil.example/trip/x' })).toBe(false);
  });
});

describe('readSharedPlan: опубликованная поездка, черновик, «нет», «не смог»', () => {
  it('опубликованная поездка — как раньше', async () => {
    db({ trip: { id: 't', title: 'Мой маршрут', arrival_date: null, departure_date: null, places: [], activities: [], days: [{ day: 1 }], transport_by_day: {} } });
    const r = await readSharedPlan(ID);
    expect(r).toMatchObject({ kind: 'found', plan: { source: 'trip', title: 'Мой маршрут' } });
  });

  it('черновик: заголовок, даты, срок ссылки, тур дня из плана — и ничего о группе', async () => {
    db({ draft: DRAFT_ROW });
    const r = await readSharedPlan(ID);
    expect(r.kind).toBe('found');
    if (r.kind !== 'found') return;
    expect(r.plan).toMatchObject({
      source: 'draft', title: draftTitle(3), arrival_date: '2026-01-10', departure_date: '2026-01-12',
      activities: ['volcano'], expires_at: EXPIRES.toISOString(), day_tour_ids: { 2: '46' },
    });
    const json = JSON.stringify(r.plan);
    expect(json).not.toMatch(/budgetTier|adults|children|wishes/);
  });

  it('черновика нет или ему больше 7 дней — «нет»', async () => {
    db({});
    expect(await readSharedPlan(ID)).toEqual({ kind: 'missing' });
    expect(await readSharedPlan('не-uuid')).toEqual({ kind: 'missing' });
  });

  it('база не ответила — «не смог», а не «нет» (и на поездке, и на черновике)', async () => {
    db({ tripFails: true });
    expect(await readSharedPlan(ID)).toEqual({ kind: 'failed' });
    db({ draftFails: true });
    expect(await readSharedPlan(ID)).toEqual({ kind: 'failed' });
  });

  it('пожелания туриста из черновика не читаются вовсе', () => {
    const drafts = readFileSync(join(process.cwd(), 'lib/planner/plan-drafts.ts'), 'utf-8');
    const loadSql = drafts.slice(drafts.indexOf('export async function loadDraft'), drafts.indexOf('export type DraftWrite'));
    expect(loadSql).toMatch(/SELECT id::text, params, days, revision, expires_at/);
    expect(loadSql).not.toMatch(/wishes/);
  });
});

const req = (path: string) => new NextRequest(`https://vedarai.ru${path}`);
const params = (token: string) => ({ params: Promise.resolve({ token }) });

describe('API страницы плана для черновика', () => {
  it('тур дня — тот, что назван в чате; подбора «лучшего по типу» нет', async () => {
    db({ draft: DRAFT_ROW });
    const res = await shareGet(req(`/api/trips/share/${ID}`), params(ID));
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Record<string, unknown> };
    expect(data.source).toBe('draft');
    expect(data.top_tours).toEqual({});
    expect(data.day_tours).toEqual({ 2: TOUR_46 });
    expect(JSON.stringify(data)).not.toMatch(/budgetTier|adults|"children"|wishes|day_tour_ids/);
    // Туры читаются по id из плана, а не подбором по activity_type.
    expect(query.mock.calls.some(([sql]) => /WHERE ot\.activity_type = \$1/.test(String(sql)))).toBe(false);
  });

  it('отказ базы — 503 «попробуйте позже», плана нет — 404', async () => {
    db({ draftFails: true });
    expect((await shareGet(req(`/api/trips/share/${ID}`), params(ID))).status).toBe(503);
    db({});
    expect((await shareGet(req(`/api/trips/share/${ID}`), params(ID))).status).toBe(404);
  });

  it('GPX черновика — точки дней с датами поездки', async () => {
    db({ draft: DRAFT_ROW });
    const res = await gpxGet(req(`/api/trips/share/${ID}/gpx`), params(ID));
    expect(res.status).toBe(200);
    const gpx = await res.text();
    expect(gpx.match(/<wpt /g)?.length).toBe(3);
    expect(gpx).toContain('<desc>2026-01-11</desc>');
  });
});

describe('страница черновика', () => {
  const page = readFileSync(join(process.cwd(), 'app/trip/[token]/page.tsx'), 'utf-8');

  it('не индексируется и не несёт разметку TouristTrip', () => {
    expect(page).toMatch(/trip\.source === 'draft'[\s\S]{0,400}robots: \{ index: false, follow: false \}/);
    expect(page).toContain("{trip.source !== 'draft' && <JsonLd data={jsonLd} />}");
  });

  it('«не смог прочитать» — ошибка, а не «не найдено»', () => {
    expect(page).toMatch(/if \(read\.kind === 'missing'\) notFound\(\);/);
    expect(page).toMatch(/if \(read\.kind === 'failed'\) throw new Error/);
  });
});
