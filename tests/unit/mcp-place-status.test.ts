/**
 * Статус места полями (ревью MCP 08.11), вызовом:
 *
 *   - правило одно с карточкой места (placeStatusFields): закрыто — всегда,
 *     цвет — только свежий, у Северных Курил зелёного нет;
 *   - get_guardian_context: «ЗАКРЫТО» печатается и у места с устаревшим
 *     цветом (до 08.11 — нет), а structuredContent несёт те же поля и
 *     сходится со своей outputSchema;
 *   - get_tour_details называет главное место тура и его статус на сегодня;
 *   - заявка на тур к закрытому, красному или жёлтому месту говорит об этом
 *     строкой и полем place_status, но не останавливается: статус — на
 *     сегодня, а тур — на свою дату; отказ чтения — словами;
 *   - ответ о названном вулкане указывает на статус места.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import Ajv from 'ajv';

const { query, createLeadMock, avail } = vi.hoisted(() => ({
  query: vi.fn(),
  createLeadMock: vi.fn(async (_: Record<string, unknown>) => 'lead-1' as string | null),
  avail: { remaining: 10, keepsSchedule: true },
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query, connect: async () => ({ query, release: () => {} }) } }));
vi.mock('@/lib/leads/create', () => ({
  createLead: (p: Record<string, unknown>) => createLeadMock(p),
  createLeadDetailed: async (p: Record<string, unknown>) => { const id = await createLeadMock(p); return id ? { id, created: true } : null; },
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: async (_id: string, from: string) => [{ date: from, remaining: avail.remaining, priceOverride: null }],
}));
vi.mock('@/lib/seat-requests/service', () => ({
  createSeatRequest: vi.fn(),
  statusUrl: (t: string) => `https://vedarai.ru/seat/${t}`,
  tourKeepsSchedule: async () => avail.keepsSchedule,
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn(async () => ({ delivered: true, channel: 'max', reason: 'доставлено' })) }));
vi.mock('@/lib/notifications/lead-notify', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  notifyPartnerNewLeadPersonally: vi.fn(async () => ({ state: 'no_channel' })),
}));

import { POST } from '@/app/api/mcp/route';
import { PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';
import { GUARDIAN_OUTPUT_SCHEMA } from '@/lib/mcp/place-status-schema';
import { WRITE_OUTPUT_SCHEMA } from '@/lib/mcp/test-run';
import { placeStatusFields } from '@/lib/safety/place-day-status';
import { TOUR_PLACE_NOT_READ_NOTE } from '@/lib/safety/tour-place-status';
import { getGuardianContextDetailed } from '@/lib/kuzmich/guardian-context';
import { getTourDetails } from '@/lib/kuzmich/core';
import { composeVolcanoReport, VOLCANO_PLACE_STATUS_POINTER, type VolcanoInput } from '@/lib/kuzmich/volcano-tool';

const ajv = new Ajv({ strict: false, allErrors: true });
const validGuardian = ajv.compile(GUARDIAN_OUTPUT_SCHEMA);
const validWrite = ajv.compile(WRITE_OUTPUT_SCHEMA);

/**
 * Ключи ответа, которых схема не объявляет: Ajv без additionalProperties их
 * пропускает, и поле, забытое в outputSchema, клиент бы не увидел описанным.
 */
function undeclaredKeys(schema: unknown, value: unknown, path = ''): string[] {
  const s = schema as { properties?: Record<string, unknown>; items?: unknown };
  if (Array.isArray(value)) return value.flatMap((v, i) => undeclaredKeys(s.items, v, `${path}[${i}]`));
  if (value && typeof value === 'object' && s?.properties) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (k in s.properties!
      ? undeclaredKeys(s.properties![k], v, `${path}.${k}`)
      : [`${path}.${k}`]));
  }
  return [];
}

const NOW = Date.now();
const fresh = () => new Date(NOW - 10 * 60_000).toISOString();
const stale = () => new Date(NOW - 5 * 3_600_000).toISOString();

const PLACE_BASE = {
  id: 'place-1', is_visible: true, name: 'Вулкан Авачинский', description: null, location_type: 'volcano', zone: null,
  lat: 53.25, lng: 158.83, hazard_types: null, profile_source: null, difficulty_level: null, altitude_m: null,
  nearest_medical_km: null, sat_communicator_required: null, registration_required: null, capacity_per_day: null,
  open_from_date: null, open_to_date: null, current_crowds: null, alert_severity: null, tourists_today: null,
  volcano_acc: null, volcano_ash_height_m: null, volcano_observed_at: null, kfegs_color: null, kfegs_raw: null,
  kfegs_seismicity: null, kfegs_date: null, linked_volcanoes: null, aliases: null,
  is_open: true, recommender_status: 'red', status_updated_at: fresh(), alert_message: null, active_alerts: ['Предупреждение МЧС: сильный ветер'],
};

const TOUR = { id: 27, title: 'Восхождение на Авачинский', operator_id: 'op-uuid-1', base_price: 13000, price_unit: 'person', nearest_free_date: null };

/** Строка tp_* загрузчика статуса места тура. */
let tourPlace: Record<string, unknown> | Error = {};
let guardianPlace: Record<string, unknown> | null = null;

function dispatch(sql: string) {
  if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
  if (/SELECT tp\.\* FROM operator_tours ot/.test(sql)) {
    if (tourPlace instanceof Error) throw tourPlace;
    return { rows: [tourPlace] };
  }
  if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
  if (/LEFT JOIN location_real_time_status lrs/.test(sql) && /FROM places p/.test(sql)) {
    return { rows: guardianPlace ? [guardianPlace] : [] };
  }
  return { rows: [] };
}

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  avail.remaining = 10;
  avail.keepsSchedule = true;
  tourPlace = {};
  guardianPlace = null;
  createLeadMock.mockClear();
  query.mockReset().mockImplementation(async (sql: string) => dispatch(sql));
});

let ip = 0;
async function call(name: string, args: Record<string, unknown>) {
  ip += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.9.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  return (await res.json()).result as {
    isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown>;
  };
}

const tp = (over: Record<string, unknown>) => ({
  tp_place_id: 'place-1', tp_place_name: 'Вулкан Авачинский', tp_place_zone: null,
  tp_is_open: true, tp_status: 'green', tp_status_at: fresh(), ...over,
});

describe('placeStatusFields — правило карточки места полями', () => {
  it('закрыто — всегда, цвет пересчёта при этом сохраняется', () => {
    expect(placeStatusFields({ isOpen: false, status: 'red', updatedAt: fresh() }, NOW))
      .toMatchObject({ level: 'closed', color: 'red', closed: true, stale: false });
  });
  it('закрыто при устаревшем пересчёте: закрыто, цвета нет, устарел', () => {
    expect(placeStatusFields({ isOpen: false, status: 'yellow', updatedAt: stale() }, NOW))
      .toMatchObject({ level: 'closed', color: null, closed: true, stale: true });
  });
  it('зелёный вне сводок края — цвета нет', () => {
    expect(placeStatusFields({ isOpen: true, status: 'green', updatedAt: fresh(), outsideKraiSources: true }, NOW))
      .toMatchObject({ level: 'unknown', color: null, outside_sources: true });
  });
  it('без времени пересчёта — цвета нет, а не цвет без времени', () => {
    expect(placeStatusFields({ isOpen: true, status: 'red', updatedAt: null }, NOW))
      .toMatchObject({ level: 'unknown', color: null, stale: false, closed: false });
  });
});

describe('get_guardian_context — заголовок и поля', () => {
  it('закрытое место с устаревшим цветом: «ЗАКРЫТО» в заголовке (до 08.11 — не печаталось)', async () => {
    guardianPlace = { ...PLACE_BASE, is_open: false, recommender_status: 'yellow', status_updated_at: stale() };
    const d = await getGuardianContextDetailed('Вулкан Авачинский');
    expect(d.text).toContain('Вулкан Авачинский (вулкан) [ЗАКРЫТО]');
    expect(d.text).toMatch(/не пересчитывался/);
    expect(d.places[0]).toMatchObject({ level: 'closed', color: null, closed: true, stale: true, match: 'high' });
  });

  it('закрытое место со свежим цветом: цвет и «ЗАКРЫТО» вместе; предупреждения — полем', async () => {
    guardianPlace = { ...PLACE_BASE, is_open: false, recommender_status: 'yellow' };
    const d = await getGuardianContextDetailed('Вулкан Авачинский');
    expect(d.text).toContain('[ЖЁЛТЫЙ — ЗАКРЫТО]');
    expect(d.found).toBe(true);
    expect(d.places[0]).toMatchObject({ id: 'place-1', level: 'closed', color: 'yellow', alerts: ['Предупреждение МЧС: сильный ветер'] });
  });
});

describe('MCP get_guardian_context: structuredContent по своей схеме', () => {
  it('tools/list объявляет outputSchema', () => {
    const tool = PUBLIC_MCP_TOOLS.find((t) => t.name === 'get_guardian_context');
    expect(tool?.outputSchema).toBe(GUARDIAN_OUTPUT_SCHEMA);
  });

  it('красное место: текст прежний, поля — те же, схема сходится', async () => {
    guardianPlace = { ...PLACE_BASE };
    const r = await call('get_guardian_context', { place: 'Вулкан Авачинский' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain('Вулкан Авачинский (вулкан) [КРАСНЫЙ]');
    expect(validGuardian(r.structuredContent), JSON.stringify(validGuardian.errors)).toBe(true);
    expect(undeclaredKeys(GUARDIAN_OUTPUT_SCHEMA, r.structuredContent)).toEqual([]);
    expect(r.structuredContent).toMatchObject({ found: true, places: [{ name: 'Вулкан Авачинский', level: 'red', color: 'red', closed: false }] });
  });

  it('места нет: found=false и пустой список — по той же схеме', async () => {
    const r = await call('get_guardian_context', { place: 'Несуществующее место' });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ found: false, places: [] });
    expect(validGuardian(r.structuredContent)).toBe(true);
  });
});

describe('get_tour_details: главное место тура и его статус на сегодня', () => {
  const ROW = { id: 27, title: TOUR.title, base_price: 13000, price_unit: 'person' };
  function detailsWith(place: Record<string, unknown>) {
    query.mockImplementation(async (sql: string) => {
      if (/tp\.tp_place_id/.test(sql)) return { rows: [{ ...ROW, ...place }] };
      if (/FROM operator_tours/.test(sql)) return { rows: [ROW] };
      return { rows: [] };
    });
  }

  it('закрытое место названо, со сроком «на сегодня» и указателем на подробности', async () => {
    detailsWith(tp({ tp_is_open: false, tp_status: 'red' }));
    const out = await getTourDetails('27');
    expect(out).toContain('Главное место тура — «Вулкан Авачинский»: сегодня отмечено ЗАКРЫТЫМ (статус для выхода КРАСНЫЙ).');
    expect(out).toMatch(/на сегодня, а не на дату тура/);
    expect(out).toMatch(/get_guardian_context/);
  });

  it('устаревший цвет не печатается; места нет — так и сказано', async () => {
    detailsWith(tp({ tp_status: 'green', tp_status_at: stale() }));
    const staleOut = await getTourDetails('27');
    expect(staleOut).toMatch(/Главное место тура — «Вулкан Авачинский»: статус не пересчитывался/);
    expect(staleOut).not.toMatch(/ЗЕЛЁНЫЙ/);

    detailsWith(tp({ tp_place_id: null, tp_place_name: null }));
    expect(await getTourDetails('27')).toMatch(/Главное место у тура не записано/);
  });
});

describe('create_booking_request: статус места строкой и полем, заявка не останавливается', () => {
  const ARGS = { name: 'Иван Петров', phone: '+79001234567', consent: true, tour: '27', date: new Date(NOW + 30 * 86_400_000).toISOString().slice(0, 10), participants: 2 };

  it('красное место, проба: строка «скажите человеку», поле place_status, схема сходится', async () => {
    tourPlace = tp({ tp_status: 'red' });
    const r = await call('create_booking_request', { ...ARGS, test: true });
    expect(r.isError, r.content[0]?.text).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/Главное место тура «Вулкан Авачинский» статус для выхода сегодня КРАСНЫЙ/);
    expect(r.content[0]!.text).toMatch(/заявку это не останавливает/);
    expect(validWrite(r.structuredContent), JSON.stringify(validWrite.errors)).toBe(true);
    expect(undeclaredKeys(WRITE_OUTPUT_SCHEMA, r.structuredContent)).toEqual([]);
    expect(r.structuredContent?.place_status).toEqual([expect.objectContaining({
      tool: 'create_booking_request', tour_id: 27, read: 'ok',
      place: expect.objectContaining({ place_id: 'place-1', place: 'Вулкан Авачинский', level: 'red', color: 'red' }),
    })]);
  });

  it('зелёное место: строки нет, поле есть', async () => {
    tourPlace = tp({ tp_status: 'green' });
    const r = await call('create_booking_request', { ...ARGS, test: true });
    expect(r.content[0]!.text).not.toMatch(/Главное место тура/);
    expect(r.structuredContent?.place_status).toEqual([expect.objectContaining({ read: 'ok', place: expect.objectContaining({ level: 'green' }) })]);
  });

  it('жёлтое место: строка тоже есть', async () => {
    tourPlace = tp({ tp_status: 'yellow' });
    const r = await call('create_booking_request', { ...ARGS, test: true });
    expect(r.content[0]!.text).toMatch(/Главное место тура «Вулкан Авачинский» статус для выхода сегодня ЖЁЛТЫЙ/);
  });

  it('статус не прочитан: так и сказано, read=failed, заявка идёт', async () => {
    tourPlace = new Error('connection terminated');
    const r = await call('create_booking_request', { ...ARGS, test: true });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain(TOUR_PLACE_NOT_READ_NOTE.trim());
    expect(r.structuredContent?.place_status).toEqual([{ tool: 'create_booking_request', tour_id: 27, read: 'failed', place: null }]);
  });

  it('настоящая заявка к закрытому месту: принята, и закрытие названо', async () => {
    tourPlace = tp({ tp_is_open: false, tp_status: 'yellow' });
    const r = await call('create_booking_request', ARGS);
    expect(r.isError, r.content[0]?.text).toBeUndefined();
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    expect(r.content[0]!.text).toMatch(/Заявка оператору принята/);
    expect(r.content[0]!.text).toMatch(/сегодня отмечено ЗАКРЫТЫМ \(статус для выхода ЖЁЛТЫЙ\)/);
    expect(r.structuredContent?.accepted).toBe(1);
    expect(validWrite(r.structuredContent), JSON.stringify(validWrite.errors)).toBe(true);
  });

  it('тур без расписания (запрос мест): строка о месте тоже доходит', async () => {
    avail.keepsSchedule = false;
    avail.remaining = 0;
    tourPlace = tp({ tp_status: 'red' });
    const r = await call('create_booking_request', { ...ARGS, test: true });
    expect(r.isError, r.content[0]?.text).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/Главное место тура «Вулкан Авачинский» статус для выхода сегодня КРАСНЫЙ/);
  });

  it('поездка целиком: место тура — в place_status итога поездки', async () => {
    tourPlace = tp({ tp_status: 'yellow' });
    const r = await call('create_trip_request', { name: 'Иван Петров', phone: '+79001234567', consent: true, tour: '27', tour_date: ARGS.date, test: true });
    expect(r.isError, r.content[0]?.text).toBeUndefined();
    expect(r.structuredContent?.place_status).toEqual([expect.objectContaining({ tool: 'create_booking_request', read: 'ok', place: expect.objectContaining({ level: 'yellow' }) })]);
  });
});

describe('get_volcano_status: ответ о вулкане указывает на статус места', () => {
  const T = Date.parse('2026-09-25T06:00:00Z');
  const INPUT: VolcanoInput = {
    kvert: [{ ark: 'a2', place_name: 'Вулкан Мутновский', name: 'Mutnovsky', acc: 'green', ash_height_m: null, observed_at: '2026-09-24T20:00:00Z' }],
    kfegsDate: '2026-09-24',
    kfegs: [{ ark: 'a2', place_name: 'Вулкан Мутновский', name: 'Мутновский', name_en: 'Mutnovsky', color: 'yellow', raw: 'Ж', seismicity: null }],
  } as VolcanoInput;

  it('названный вулкан — указатель есть; сводка без имени — нет', () => {
    expect(composeVolcanoReport(INPUT, 'Мутновский', T)).toContain(VOLCANO_PLACE_STATUS_POINTER);
    expect(composeVolcanoReport(INPUT, undefined, T)).not.toContain(VOLCANO_PLACE_STATUS_POINTER);
  });
});
