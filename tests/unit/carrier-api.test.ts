// @vitest-environment node
/**
 * Сторожа API трансферов (схема 926, 02.09) — рождены вместе с API, а не
 * после первого инцидента (решение владельца 01.09).
 *
 *   1. Пути НОВЫЕ: ни один роут не живёт по адресам мёртвого модуля
 *      (/api/transfer, /api/transfers/*, /api/transfer-operator, /api/hub/transfer).
 *   2. Кабинет: каждый роут под /api/hub/carrier зовёт requireCarrier раньше
 *      сервиса; на Edge префикс не публичен.
 *   3. Витрина (класс tour-card-standard): единственная реализация чтения —
 *      listPublishedTrips с фильтром is_published; ни один роут не читает
 *      transfer_trips сам. GET публичен на Edge, запрос мест — за входом.
 *   4. Гейт брони: места занимаются только confirmSeats под FOR UPDATE;
 *      UPDATE по transfer_seat_bookings вне lib/transfers/service.ts нет.
 *   5. Витрина исполняется: ответ несёт searched: true и окно дат; пустой
 *      список — факт, отказ сервиса — 503 с searched: false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NextRequest } from 'next/server';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

const listPublishedTripsMock = vi.fn();
vi.mock('@/lib/transfers/service', () => ({
  listPublishedTrips: (...a: unknown[]) => listPublishedTripsMock(...a),
}));

import { GET as vitrinaGet, MAX_WINDOW_DAYS } from '@/app/api/carrier-trips/route';

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function routesUnder(dir: string): string[] {
  const acc: string[] = [];
  // withFileTypes: тип записи приходит вместе с именем, без отдельного stat
  // между чтением каталога и чтением файла (CodeQL js/file-system-race).
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'route.ts') acc.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, dir));
  return acc.sort();
}

const CARRIER = routesUnder('app/api/hub/carrier');
const VITRINA = routesUnder('app/api/carrier-trips');
const ALL = [...CARRIER, ...VITRINA];

describe('1. пути новые', () => {
  it('роуты найдены', () => {
    expect(CARRIER.length).toBeGreaterThanOrEqual(5);
    expect(VITRINA.length).toBeGreaterThanOrEqual(2);
  });

  it('адресов мёртвого модуля в дереве нет', () => {
    for (const dead of ['app/api/transfer/', 'app/api/transfers/', 'app/api/transfer-operator/', 'app/hub/transfer/', 'app/hub/transfer-operator/']) {
      expect(existsSync(join(ROOT, dead)), `${dead} ожил`).toBe(false);
    }
  });
});

describe('2. кабинет перевозчика', () => {
  it('каждый роут зовёт requireCarrier раньше сервиса', () => {
    for (const f of CARRIER) {
      const src = strip(readFileSync(join(ROOT, f), 'utf8'));
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)];
      expect(handlers.length, `${f}: нет хендлера`).toBeGreaterThan(0);
      handlers.forEach((h, i) => {
        const end = i + 1 < handlers.length ? handlers[i + 1].index! : src.length;
        const body = src.slice(h.index!, end);
        const guard = body.indexOf('requireCarrier(');
        const svc = body.search(/\b(listVehicles|addVehicle|createTrip|listTripsForPartner|setTripPublished|listSeatRequests|confirmSeats|declineSeats|requestSeats)\(/);
        expect(guard, `${f} ${h[1]}: нет requireCarrier`).toBeGreaterThan(-1);
        if (svc >= 0) expect(guard, `${f} ${h[1]}: сервис раньше проверки`).toBeLessThan(svc);
      });
    }
  });

  it('на Edge кабинет не публичен', () => {
    for (const m of ['GET', 'POST']) expect(isPublicApiPath('/api/hub/carrier/trips', m)).toBe(false);
  });
});

describe('3. витрина — одна реализация чтения', () => {
  it('ни один роут не читает transfer_trips / transfer_seat_bookings сам', () => {
    for (const f of ALL) {
      const src = strip(readFileSync(join(ROOT, f), 'utf8'));
      expect(src, `${f}: прямой SQL к таблицам трансферов`).not.toMatch(/FROM transfer_|UPDATE transfer_|INSERT INTO transfer_/);
    }
  });

  it('фильтр is_published живёт в listPublishedTrips и только там', () => {
    const svc = strip(readFileSync(join(ROOT, 'lib/transfers/service.ts'), 'utf8'));
    const at = svc.indexOf('export async function listPublishedTrips');
    expect(at).toBeGreaterThan(0);
    expect(svc.slice(at, at + 2500)).toMatch(/WHERE t\.is_published/);
    for (const f of VITRINA) {
      // Витрина читает через listPublishedTrips, запрос мест — requestSeats,
      // оплата места (928) — issueSeatQr / getSeatBookingForPayment.
      expect(readFileSync(join(ROOT, f), 'utf8')).toMatch(/listPublishedTrips|requestSeats|issueSeatQr|getSeatBookingForPayment/);
    }
  });

  it('GET витрины публичен на Edge, запрос мест — нет', () => {
    expect(isPublicApiPath('/api/carrier-trips', 'GET')).toBe(true);
    expect(isPublicApiPath('/api/carrier-trips', 'POST')).toBe(false);
    expect(isPublicApiPath('/api/carrier-trips/abc/request', 'POST')).toBe(false);
  });
});

describe('4. гейт брони', () => {
  it('UPDATE transfer_seat_bookings — только в сервисе, и только confirmSeats берёт FOR UPDATE', () => {
    const svc = strip(readFileSync(join(ROOT, 'lib/transfers/service.ts'), 'utf8'));
    const confirmAt = svc.indexOf('export async function confirmSeats');
    const confirmBody = svc.slice(confirmAt, svc.indexOf('export async function declineSeats'));
    expect(confirmBody).toMatch(/FOR UPDATE/);
    expect(confirmBody.indexOf('FOR UPDATE')).toBeLessThan(confirmBody.indexOf("status = 'confirmed'"));
    // Вне сервиса — ни одной записи в брони мест (app/ и lib/ целиком).
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (!/node_modules|\.next/.test(e.name)) walk(p); continue; }
        if (!e.isFile() || !/\.ts$/.test(e.name) || p.endsWith('lib/transfers/service.ts')) continue;
        if (/UPDATE transfer_seat_bookings/.test(strip(readFileSync(p, 'utf8')))) offenders.push(relative(ROOT, p));
      }
    };
    walk(join(ROOT, 'app')); walk(join(ROOT, 'lib'));
    expect(offenders).toEqual([]);
  });

  it('решение перевозчика идёт через confirmSeats/declineSeats', () => {
    const src = strip(readFileSync(join(ROOT, 'app/api/hub/carrier/requests/[id]/route.ts'), 'utf8'));
    expect(src).toMatch(/confirmSeats\(/);
    expect(src).toMatch(/declineSeats\(/);
  });
});

describe('5. витрина исполняется', () => {
  beforeEach(() => { listPublishedTripsMock.mockReset(); });
  const req = (qs: string) => new NextRequest(`https://vedarai.ru/api/carrier-trips${qs}`);

  it('нашли ноль — это факт: searched: true, окно дат в ответе', async () => {
    listPublishedTripsMock.mockResolvedValue([]);
    const res = await vitrinaGet(req('?from=2026-09-10&to=2026-09-12'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.searched).toBe(true);
    expect(body.window).toEqual({ from: '2026-09-10', to: '2026-09-12', min_seats: 1, place_id: null });
    expect(body.trips).toEqual([]);
    expect(listPublishedTripsMock).toHaveBeenCalledWith({ fromDate: '2026-09-10', toDate: '2026-09-12', minSeats: 1, placeId: null });
  });

  it('сервис упал — 503 и searched: false, не пустой список', async () => {
    listPublishedTripsMock.mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await vitrinaGet(req('?from=2026-09-10&to=2026-09-12'));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.searched).toBe(false);
    expect(body.trips).toBeUndefined();
    errSpy.mockRestore();
  });

  it('окно больше предела или «до» раньше «от» — 400, сервис не зовётся', async () => {
    const wide = await vitrinaGet(req(`?from=2026-09-01&to=2026-12-31`));
    expect(wide.status).toBe(400);
    const flipped = await vitrinaGet(req('?from=2026-09-12&to=2026-09-10'));
    expect(flipped.status).toBe(400);
    expect(listPublishedTripsMock).not.toHaveBeenCalled();
    expect(MAX_WINDOW_DAYS).toBe(60);
  });

  it('без дат — окно по умолчанию от сегодня', async () => {
    listPublishedTripsMock.mockResolvedValue([]);
    const res = await vitrinaGet(req(''));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.window.from).toBe(new Date().toISOString().slice(0, 10));
  });
});
