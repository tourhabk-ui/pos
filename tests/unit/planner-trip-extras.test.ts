/**
 * Сторож: «Что ещё нужно» к плану поездки (решение владельца 26.09).
 *
 * Держит связку целиком:
 *   ночи      — стоянки выводятся из дней плана: северная зона ночует в
 *               Авачинской, ночь тура с проживанием жилья не требует, день
 *               отъезда — не ночь;
 *   жильё     — только витрина (одобрено и не скрыто), только размеченная
 *               зона (NULL не предлагается), свободность — общей формулой
 *               каталога (roomNightsSql), не своей;
 *   трансфер  — только listPublishedTrips, окно = даты поездки, места на
 *               всю группу (взрослые + дети); свободный текст перевозчика
 *               наружу не уходит;
 *   машина    — честное «пока нет», без прокатчиков и ссылок наружу;
 *   три исхода — «не смог» не выдаётся за «нет» и пишет в лог имя и SQLSTATE;
 *   зона      — миграция 1030 (CHECK из четырёх зон движка, без угадывания),
 *               обязательна у нового объекта владельца, админ ставит и
 *               снимает её на модерации.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));
const listTripsMock = vi.fn();
vi.mock('@/lib/transfers/service', () => ({
  listPublishedTrips: (...args: unknown[]) => listTripsMock(...args),
}));
const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...args: unknown[]) => queryMock(...args) }));
const requireAuthMock = vi.fn();
const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...a: unknown[]) => requireAuthMock(...a),
  requireAdmin: (...a: unknown[]) => requireAdminMock(...a),
  requireRole: (...a: unknown[]) => requireAuthMock(...a),
}));
vi.mock('@/lib/auth/partner-profile', () => ({ ensurePartnerForRole: vi.fn().mockResolvedValue('partner-1') }));

import { lodgingStays, groupSeats, CAR_RENTAL_ANSWER, type ExtrasDay } from '@/lib/planner/trip-extras';
import {
  LODGING_FOR_STAY_SQL, UNZONED_PUBLIC_COUNT_SQL, findLodgingForStay, findTransfers,
} from '@/lib/planner/trip-extras-data';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { ZONE_IDS, sleepZoneOf } from '@/lib/planner/constants';
import { POST as extrasRoute } from '@/app/api/planner/trip-extras/route';
import { POST as createAccommodation } from '@/app/api/stay/accommodations/route';
import { PATCH as adminDecide } from '@/app/api/admin/accommodations/[id]/route';
import { PATCH as ownerPatch } from '@/app/api/accommodations/[id]/route';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const ACC_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';

function req(url: string, method: string, body?: unknown, ip = '10.0.0.1'): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

let ipSeq = 0;
const extras = async (body: unknown) => {
  // Свой IP на каждый запрос — лимитер роута не должен влиять на проверку.
  const res = await extrasRoute(req('http://localhost/api/planner/trip-extras', 'POST', body, `10.1.0.${++ipSeq}`));
  return { status: res.status, json: await res.json() as { success: boolean; data?: Record<string, unknown>; error?: string } };
};

beforeEach(() => {
  poolQueryMock.mockReset();
  listTripsMock.mockReset();
  queryMock.mockReset();
  requireAuthMock.mockReset();
  requireAdminMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'user-1', email: 'o@x.ru', role: 'stay' });
  requireAdminMock.mockResolvedValue({ userId: ADMIN_ID, email: 'a@x.ru', role: 'admin' });
});

// ── Ночи плана ──────────────────────────────────────────────────────────────

describe('стоянки из дней плана', () => {
  const plan: ExtrasDay[] = [
    { day: 1, type: 'arrival', zone: 'avachinsky' },
    { day: 2, type: 'activity', zone: 'northern' },
    { day: 3, type: 'travel', zone: 'western' },
    { day: 4, type: 'activity', zone: 'western', lodgingIncluded: true },
    { day: 5, type: 'activity', zone: 'western', lodgingIncluded: null },
    { day: 6, type: 'departure', zone: 'avachinsky' },
  ];

  it('соседние ночи одной зоны — одна стоянка; северная ночует в Авачинской', () => {
    const { stays } = lodgingStays(plan, '2030-08-03', '2030-08-08');
    expect(stays[0]).toEqual({ zone: 'avachinsky', checkIn: '2030-08-03', checkOut: '2030-08-05', nights: 2 });
    expect(sleepZoneOf('northern')).toBe('avachinsky');
  });

  it('ночь тура с проживанием жилья не требует и разрывает стоянку; null — требует', () => {
    const { stays, nightsInTours } = lodgingStays(plan, '2030-08-03', '2030-08-08');
    expect(nightsInTours).toBe(1);
    expect(stays.slice(1)).toEqual([
      { zone: 'western', checkIn: '2030-08-05', checkOut: '2030-08-06', nights: 1 },
      { zone: 'western', checkIn: '2030-08-07', checkOut: '2030-08-08', nights: 1 },
    ]);
  });

  it('день отъезда и ночи после даты отъезда — не ночи поездки', () => {
    const { stays } = lodgingStays([
      { day: 1, type: 'arrival', zone: 'avachinsky' },
      { day: 2, type: 'activity', zone: 'avachinsky' },
      { day: 3, type: 'buffer', zone: 'avachinsky' },
    ], '2030-08-03', '2030-08-04');
    expect(stays).toEqual([{ zone: 'avachinsky', checkIn: '2030-08-03', checkOut: '2030-08-04', nights: 1 }]);
  });

  it('места в трансфере — на всех: взрослые и дети', () => {
    expect(groupSeats(2, [5, 9])).toBe(4);
  });
});

// ── Жильё: запрос ───────────────────────────────────────────────────────────

describe('жильё: только витрина, только размеченная зона, общая формула', () => {
  it('SQL спрашивает одобрение, зону и свободность на все ночи по roomNightsSql', () => {
    expect(LODGING_FOR_STAY_SQL).toContain(publicAccommodationSql('a'));
    expect(LODGING_FOR_STAY_SQL).toMatch(/a\.planner_zone = \$1::varchar/);
    // Общая формула занятости (lib/stay/availability) — узнаётся по её телу.
    expect(LODGING_FOR_STAY_SQL).toContain('accommodation_availability');
    expect(LODGING_FOR_STAY_SQL).toContain("b.status IN ('confirmed', 'completed')");
    expect(LODGING_FOR_STAY_SQL).toMatch(/HAVING bool_and\(NOT rn\.blocked AND rn\.free_units > 0\)/);
    // Своего правила «свободно» здесь нет.
    expect(read('lib/planner/trip-extras-data.ts')).toMatch(/import \{ roomNightsSql \} from '@\/lib\/stay\/availability'/);
    // NULL-зона не предлагается: ни «IS NULL», ни угадывания по тексту.
    expect(LODGING_FOR_STAY_SQL).not.toMatch(/planner_zone IS NULL/);
    expect(LODGING_FOR_STAY_SQL).not.toMatch(/location_zone|ILIKE/);
  });

  it('объекты без зоны только считаются, не предлагаются', () => {
    expect(UNZONED_PUBLIC_COUNT_SQL).toMatch(/planner_zone IS NULL/);
    expect(UNZONED_PUBLIC_COUNT_SQL).toContain(publicAccommodationSql('a'));
    expect(UNZONED_PUBLIC_COUNT_SQL).toMatch(/COUNT\(\*\)/);
  });

  it('варианты: цена null остаётся null, оценка без отзывов — не оценка', async () => {
    poolQueryMock.mockResolvedValue({ rows: [
      { id: 'a1', name: 'Дом', type: 'guesthouse', price_from: null, rating: '0.00', review_count: 0, is_verified: false },
      { id: 'a2', name: 'База', type: 'hotel', price_from: '4500.00', rating: '4.60', review_count: 12, is_verified: true },
    ] });
    const r = await findLodgingForStay({ zone: 'avachinsky', checkIn: '2030-08-03', checkOut: '2030-08-05', nights: 2 });
    expect(r.state).toBe('ok');
    if (r.state !== 'ok') return;
    expect(r.items[0]).toMatchObject({ priceFrom: null, rating: null });
    expect(r.items[1]).toMatchObject({ priceFrom: 4500, rating: 4.6, reviewCount: 12, isVerified: true });
    expect(poolQueryMock.mock.calls[0][1]).toEqual(['avachinsky', '2030-08-03', '2030-08-05', 3]);
  });

  it('пусто — «empty», отказ базы — «unavailable» и имя + SQLSTATE в лог', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    expect(await findLodgingForStay({ zone: 'western', checkIn: '2030-08-03', checkOut: '2030-08-04', nights: 1 }))
      .toEqual({ state: 'empty' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQueryMock.mockRejectedValueOnce(Object.assign(new Error('column does not exist'), { code: '42703' }));
    expect(await findLodgingForStay({ zone: 'western', checkIn: '2030-08-03', checkOut: '2030-08-04', nights: 1 }))
      .toEqual({ state: 'unavailable' });
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/подбор жилья.*sqlstate=42703/);
    spy.mockRestore();
  });
});

// ── Трансфер ────────────────────────────────────────────────────────────────

describe('трансфер: витрина перевозчиков, окно дат, места на всю группу', () => {
  const trip = {
    id: 't1', vehicle_id: 'v1', trip_date: '2030-08-03', from_text: 'Аэропорт', to_text: 'Паратунка',
    to_place_id: null, to_route_id: null, departure_note: '10:00', seats_total: 8, price_per_seat: '1500',
    is_published: true, status: 'planned', comment: 'звоните +79990000000',
    partner_id: 'p1', partner_name: 'Перевозчик', vehicle_kind: 'minibus', vehicle_title: 'Спринтер',
    seats_taken: 0, seats_free: 8,
  };

  it('зовёт listPublishedTrips с окном и числом мест; комментарий перевозчика не отдаёт', async () => {
    listTripsMock.mockResolvedValue([trip]);
    const r = await findTransfers({ fromDate: '2030-08-03', toDate: '2030-08-12', seats: 4 });
    expect(listTripsMock).toHaveBeenCalledWith({ fromDate: '2030-08-03', toDate: '2030-08-12', minSeats: 4, placeId: null });
    expect(r.state).toBe('ok');
    expect(JSON.stringify(r)).not.toContain('+7999');
    expect(JSON.stringify(r)).not.toContain('comment');
  });

  it('роут: окно = даты поездки, места = взрослые + дети', async () => {
    listTripsMock.mockResolvedValue([]);
    const { json } = await extras({
      needs: { transfer: true }, arrivalDate: '2030-08-03', departureDate: '2030-08-12', adults: 2, children: [7],
    });
    expect(listTripsMock).toHaveBeenCalledWith({ fromDate: '2030-08-03', toDate: '2030-08-12', minSeats: 3, placeId: null });
    expect(json.data?.transfer).toEqual({ state: 'empty', window: { from: '2030-08-03', to: '2030-08-12', seats: 3 } });
  });

  it('отказ витрины — «unavailable», а не «поездок нет»', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    listTripsMock.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    const r = await findTransfers({ fromDate: '2030-08-03', toDate: '2030-08-12', seats: 1 });
    expect(r).toEqual({ state: 'unavailable' });
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/sqlstate=57P01/);
    spy.mockRestore();
  });
});

// ── Роут ────────────────────────────────────────────────────────────────────

describe('POST /api/planner/trip-extras', () => {
  it('машина — честное «пока нет», без ссылок наружу', async () => {
    const { json } = await extras({ needs: { car: true } });
    expect(json.data?.car).toEqual(CAR_RENTAL_ANSWER);
    expect(CAR_RENTAL_ANSWER.message).toBe('Аренды автомобилей на платформе пока нет');
    expect(JSON.stringify(CAR_RENTAL_ANSWER)).not.toMatch(/https?:|www\./);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('жильё без дат — «укажите даты», а не «жилья нет»', async () => {
    const { json } = await extras({ needs: { lodging: true }, days: [] });
    expect(json.data?.lodging).toEqual({ state: 'no_dates' });
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('жильё: по стоянке на зону ночёвки, число неразмеченных рядом', async () => {
    poolQueryMock.mockImplementation((sql: string) => Promise.resolve(
      sql.includes('planner_zone IS NULL') ? { rows: [{ n: 2 }] } : { rows: [] },
    ));
    const { json } = await extras({
      needs: { lodging: true }, arrivalDate: '2030-08-03', departureDate: '2030-08-05', adults: 2,
      days: [
        { day: 1, type: 'arrival', zone: 'avachinsky' },
        { day: 2, type: 'activity', zone: 'eastern' },
        { day: 3, type: 'departure', zone: 'avachinsky' },
      ],
    });
    const lodging = json.data?.lodging as { state: string; stays: Array<{ zone: string; zoneName: string; result: unknown }>; unzonedCount: number };
    expect(lodging.state).toBe('checked');
    expect(lodging.stays.map((s) => [s.zone, s.zoneName])).toEqual([['avachinsky', 'Авачинская зона'], ['eastern', 'Восточная зона']]);
    expect(lodging.stays[0].result).toEqual({ state: 'empty' });
    expect(lodging.unzonedCount).toBe(2);
  });

  it('ничего не отмечено — ничего не ищем', async () => {
    const { json } = await extras({ needs: {} });
    expect(json.data).toEqual({});
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(listTripsMock).not.toHaveBeenCalled();
  });

  it('Zod: needs обязателен и булев, зона — только из движка', async () => {
    expect((await extras({})).status).toBe(400);
    expect((await extras({ needs: { lodging: 'yes' } })).status).toBe(400);
    expect((await extras({ needs: { lodging: true }, days: [{ day: 1, type: 'arrival', zone: 'southern' }] })).status).toBe(400);
  });

  it('публичный на Edge — и потому с лимитером', () => {
    expect(read('lib/auth/public-api-routes.ts')).toMatch(/'\/api\/planner\/trip-extras':\s+\['POST'\]/);
    expect(read('app/api/planner/trip-extras/route.ts')).toMatch(/createRateLimiter/);
  });
});

// ── Зона у объекта ──────────────────────────────────────────────────────────

describe('миграция 1030: зона планера у объекта', () => {
  const m = read('migrations/1030_accommodation_planner_zone.sql');

  it('колонка NULL, CHECK ровно из зон движка, идемпотентно, индекс', () => {
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS planner_zone VARCHAR\(20\) NULL/);
    const check = m.match(/planner_zone IN \(([^)]*)\)/)?.[1] ?? '';
    expect(check.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...ZONE_IDS]);
    expect(m).toMatch(/planner_zone IS NULL OR/);
    expect(m).toMatch(/IF NOT EXISTS[\s\S]*accommodations_planner_zone_check/);
    expect(m).toMatch(/CREATE INDEX IF NOT EXISTS idx_accommodations_planner_zone/);
  });

  it('без угадывания: ни UPDATE по тексту, ни по координатам', () => {
    const sql = m.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });
});

describe('зона в кабинете владельца', () => {
  it('новый объект без зоны — 400, с зоной — в INSERT', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'partner-1' }] });
      if (sql.includes('INSERT INTO accommodations')) return Promise.resolve({ rows: [{ id: ACC_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    const base = { name: 'Дом у вулкана', description: 'Тёплый дом у подножия', type: 'guesthouse', coordinates: { lat: 53, lng: 158 } };
    const bad = await createAccommodation(req('http://localhost/api/stay/accommodations', 'POST', base));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/зону/);

    const ok = await createAccommodation(req('http://localhost/api/stay/accommodations', 'POST', { ...base, plannerZone: 'western' }));
    expect(ok.status).toBe(201);
    const call = queryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO accommodations'))!;
    expect(String(call[0])).toMatch(/planner_zone/);
    expect(call[1]).toContain('western');
  });

  it('правка владельца пишет planner_zone; чужую зону не принимает', async () => {
    queryMock.mockImplementation((sql: string) => Promise.resolve(
      sql.includes('UPDATE accommodations') ? { rows: [{ id: ACC_ID }] } : { rows: [{ exists: true, id: ACC_ID, partner_id: 'partner-1' }] },
    ));
    const ok = await ownerPatch(req(`http://localhost/api/accommodations/${ACC_ID}`, 'PATCH', { plannerZone: 'eastern' }), { params: Promise.resolve({ id: ACC_ID }) });
    expect(ok.status).toBe(200);
    const upd = queryMock.mock.calls.find(([s]) => String(s).includes('UPDATE accommodations'))!;
    expect(String(upd[0])).toMatch(/planner_zone = \$1/);
    expect(upd[1]).toContain('eastern');
    const bad = await ownerPatch(req(`http://localhost/api/accommodations/${ACC_ID}`, 'PATCH', { plannerZone: 'moon' }), { params: Promise.resolve({ id: ACC_ID }) });
    expect(bad.status).toBe(400);
  });

  it('формы владельца несут поле зоны', () => {
    const create = read('components/hub/AccommodationCreateForm.tsx');
    expect(create).toMatch(/Зона для планера/);
    expect(create).toMatch(/ZONE_IDS\.map/);
    expect(create).toMatch(/plannerZone !== ''/); // без зоны форма не отправляется
    expect(create).toMatch(/plannerZone,\n/);
    const edit = read('app/hub/stay/accommodations/_AccommodationsClient.tsx');
    expect(edit).toMatch(/Зона для планера/);
    expect(edit).toMatch(/payload\.plannerZone = form\.plannerZone/);
  });
});

describe('зона на модерации', () => {
  const params = { params: Promise.resolve({ id: ACC_ID }) };
  const url = `http://localhost/api/admin/accommodations/${ACC_ID}`;

  it('одобрение с зоной ставит её, без зоны — оставляет прежнюю (COALESCE)', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ id: ACC_ID, name: 'Дом', moderation_status: 'approved', is_verified: true, is_active: true }] });
    await adminDecide(req(url, 'PATCH', { action: 'approve', plannerZone: 'northern' }), params);
    const [sql, p] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/planner_zone\s+= COALESCE\(\$6::varchar, planner_zone\)/);
    expect(p[5]).toBe('northern');
  });

  it('set_zone ставит и снимает зону; чужая зона — 400', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ id: ACC_ID, name: 'Дом', planner_zone: null }] });
    const off = await adminDecide(req(url, 'PATCH', { action: 'set_zone', plannerZone: null }), params);
    expect(off.status).toBe(200);
    expect(poolQueryMock.mock.calls[0][1]).toEqual([ACC_ID, null]);
    expect(String(poolQueryMock.mock.calls[0][0])).toMatch(/SET planner_zone = \$2::varchar/);
    const bad = await adminDecide(req(url, 'PATCH', { action: 'set_zone', plannerZone: 'moon' }), params);
    expect(bad.status).toBe(400);
  });

  it('экран модерации показывает зону и даёт её поставить', () => {
    const src = read('app/hub/admin/accommodations/_AccommodationModerationClient.tsx');
    expect(src).toMatch(/Зона для планера/);
    expect(src).toMatch(/action: 'set_zone'/);
    expect(src).toMatch(/plannerZone: draftZone\(row\)/);
    expect(read('app/api/admin/accommodations/route.ts')).toMatch(/plannerZone: r\.planner_zone/);
  });
});
