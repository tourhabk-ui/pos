// @vitest-environment node
/**
 * GET /api/planner/day-options (супер-планер 22.11): варианты дня из базы на
 * дату дня — места и цена перечитываются на каждый запрос (не кэшируются),
 * многодневные туры не предлагаются, отказ базы — 500, а не «вариантов нет».
 * Случай владельца: облёт 26.11.2026, двое взрослых, Авачинская зона.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { queryMock, rereadMock } = vi.hoisted(() => ({ queryMock: vi.fn(), rereadMock: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: queryMock } }));
vi.mock('@/lib/planner/require-session', () => ({ plannerSession: vi.fn(async () => ({ userId: 'u-planner' })) }));
vi.mock('@/lib/planner/tour-day-reread', () => ({ rereadTourDay: rereadMock }));

import { GET } from '@/app/api/planner/day-options/route';
import { OFFER_ORDER_NOTE } from '@/lib/tours/offer-order';

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id, title: `Тур ${id}`, short_description: null, base_price: '48000', price_unit: 'per_person',
    activity_type: 'helicopter', min_participants: 4, max_participants: 20,
    duration_hours: 8, multi_day_count: null, duration_type: 'hours',
    season_start: null, season_end: null, keeps_schedule: true,
    free_on_date: '2026-11-26', nearest_free_date: '2026-11-26', any_day_open: true,
    lat: 54.4, lng: 160.1, operator_name: 'Вертолёты Камчатки', operator_slug: 'heli-kam',
    ...over,
  };
}

const URL_SAME = 'https://vedarai.ru/api/planner/day-options?mode=same&activity_type=helicopter&zone=avachinsky&date=2026-11-26&participants=2&exclude=98';
const get = (url: string) => GET(new NextRequest(url));

beforeEach(() => {
  queryMock.mockReset();
  rereadMock.mockReset();
  rereadMock.mockImplementation(async ({ tourId }: { tourId: string }) => ({ availability: 'open', checkedAt: 'x', availableDate: '2026-11-26', slotsRemaining: Number(tourId), priceFrom: 0, priceTo: 0 }));
});

describe('варианты дня', () => {
  it('тот же вид в зоне дня; тур дня исключён; многодневный и без выезда в дату — нет; места — свежим чтением', async () => {
    queryMock.mockResolvedValue({ rows: [
      row('501'),
      row('502', { multi_day_count: 3, duration_type: 'days', duration_hours: null }),
      row('503', { free_on_date: null, nearest_free_date: '2026-12-10' }),
    ] });
    const res = await get(URL_SAME);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; options: Array<{ id: string; otherZone: boolean; read: { slotsRemaining: number } }>; orderNote: string };
    expect(body.options.map((o) => o.id)).toEqual(['501']);
    expect(body.options[0].otherZone).toBe(false);
    expect(body.options[0].read.slotsRemaining).toBe(501);
    expect(body.orderNote).toBe(OFFER_ORDER_NOTE.ru);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/activity_type = ANY\(\$2::text\[\]\)/);
    expect(params[0]).toBe('2026-11-26');
    expect(params[2]).toBe('98');
    expect(params[3]).toBe('avachinsky');
    expect(rereadMock).toHaveBeenCalledWith({ tourId: '501', date: '2026-11-26', participants: 2, maxParticipants: 20 });
  });

  it('наличие мест не кэшируется: второй запрос — снова база и снова перечитка', async () => {
    queryMock.mockResolvedValue({ rows: [row('501')] });
    await get(URL_SAME);
    await get(URL_SAME);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(rereadMock).toHaveBeenCalledTimes(2);
  });

  it('в зоне дня пусто — другие зоны, с пометкой «другая зона»', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row('601')] });
    const body = await (await get(URL_SAME)).json() as { options: Array<{ id: string; otherZone: boolean }> };
    expect(body.options).toEqual([expect.objectContaining({ id: '601', otherZone: true })]);
    expect((queryMock.mock.calls[1] as [string, unknown[]])[1]).toHaveLength(3);
  });

  it('замена на земле (План Б): вертолёт, море, вулкан, гейзеры — исключены запросом', async () => {
    queryMock.mockResolvedValue({ rows: [row('701', { activity_type: 'thermal' })] });
    const res = await get('https://vedarai.ru/api/planner/day-options?mode=ground&zone=avachinsky&date=2026-11-26&participants=2&limit=2');
    expect(res.status).toBe(200);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/NOT \(ot\.activity_type = ANY\(\$2::text\[\]\)\)/);
    expect(params[1]).toEqual(expect.arrayContaining(['helicopter', 'boat_trip', 'volcano', 'geyser']));
  });

  it('замена на земле: облёт или катер, записанные чужим видом, узнаются по названию и не предлагаются', async () => {
    queryMock.mockResolvedValue({ rows: [
      row('801', { activity_type: 'excursion', title: 'Облёт Курильского озера' }),
      row('802', { activity_type: 'excursion', title: 'Морская прогулка на катере по Авачинской бухте' }),
      row('803', { activity_type: 'thermal', title: 'Паратунка' }),
    ] });
    const body = await (await get('https://vedarai.ru/api/planner/day-options?mode=ground&zone=avachinsky&date=2026-11-26&participants=2')).json() as { options: Array<{ id: string }> };
    expect(body.options.map((o) => o.id)).toEqual(['803']);
  });

  it('скрытый оператор (is_public = false) в варианты не попадает — условие в запросе', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await get(URL_SAME);
    expect((queryMock.mock.calls[0] as [string])[0]).toMatch(/p\.is_public = TRUE/);
  });

  it('места одного варианта не прочитались — «не прочитали» (read: null), а не «мест нет»', async () => {
    queryMock.mockResolvedValue({ rows: [row('501')] });
    rereadMock.mockRejectedValueOnce(new Error('timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await (await get(URL_SAME)).json() as { options: Array<{ read: unknown }> };
    expect(body.options[0].read).toBeNull();
  });

  it('база отказала — 500 «не загрузились», а не пустой список', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('down'), { code: '57P01' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get(URL_SAME);
    expect(res.status).toBe(500);
    expect((await res.json() as { success: boolean }).success).toBe(false);
  });

  it('без вида занятия для «same» или без даты — 400, база не зовётся', async () => {
    expect((await get('https://vedarai.ru/api/planner/day-options?mode=same&zone=avachinsky&date=2026-11-26&participants=2')).status).toBe(400);
    expect((await get('https://vedarai.ru/api/planner/day-options?mode=ground&zone=avachinsky&participants=2')).status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
