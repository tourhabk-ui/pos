/**
 * Числа кабинета туриста считаются по ВОШЕДШЕМУ, а не по email из формы.
 *
 * ── Повод ─────────────────────────────────────────────────────────────────
 *
 * `GET /api/tourist/summary` отбирал брони `WHERE tourist_email = $1` — по
 * адресу из JWT. Но `tourist_email` заполняет ФОРМА брони
 * (`app/api/hub/bookings/create`), и гостевую бронь она принимает БЕЗ
 * авторизации. Значит любой мог оформить бронь на чужой адрес, и хозяин адреса
 * увидел бы в «Моей Камчатке» чужую поездку и чужую сумму. Зеркальная ошибка
 * там же: свою бронь, оформленную на другой адрес, человек не видел вовсе.
 *
 * Скоуп кабинета один — `operator_bookings.user_id` (`lib/tourist/cabinet.ts`,
 * тот же источник у `/api/tourist/stats` и `/api/tourist/profile`).
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Правило, а не место: ни один роут кабинета туриста не отбирает брони по
 * email. Плюс поведение сводки: считает общий модуль, и в SQL стоит `user_id`,
 * а email в параметрах не участвует.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
const poolQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

import { GET as summary } from '@/app/api/tourist/summary/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'turist@example.com';

const TOURIST_API = join(process.cwd(), 'app/api/tourist');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

beforeEach(() => {
  queryMock.mockReset();
  poolQueryMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: USER_ID, email: EMAIL, role: 'tourist' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('правило: брони кабинета не отбираются по email', () => {
  it('ни один роут кабинета туриста не фильтрует tourist_email', () => {
    const offenders: string[] = [];
    for (const f of routeFiles(TOURIST_API)) {
      // Комментарии из счёта исключены: разбор дефекта, записанный рядом с
      // починкой, цитирует прежний предикат — и сторож ловил бы объяснение
      // вместо кода.
      const code = readFileSync(f, 'utf-8')
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
      // Отбор по адресу из формы: WHERE/AND ... tourist_email = $n
      if (/tourist_email\s*=\s*\$\d/.test(code)) offenders.push(f.replace(process.cwd() + '/', ''));
    }
    expect(
      offenders,
      'роут кабинета отбирает брони по tourist_email. Это адрес из ФОРМЫ брони, '
      + 'а гостевую бронь форма принимает без авторизации — по нему в кабинет '
      + 'попадает чужая поездка. Скоуп один: ob.user_id (lib/tourist/cabinet.ts)',
    ).toEqual([]);
  });
});

describe('сводка считает общим модулем кабинета', () => {
  it('в SQL стоит user_id, email в параметрах не участвует', async () => {
    queryMock.mockResolvedValue({ rows: [{ total: '2', completed: '1', upcoming: '0', active: '0', spent: '5000', n: '0', avg: null }], rowCount: 1 });
    poolQueryMock.mockResolvedValue({ rows: [{ utility: '10', contribution: '20' }], rowCount: 1 });

    const res = await summary(new Request('http://localhost/api/tourist/summary'));
    expect(res.status).toBe(200);

    const bookingCalls = queryMock.mock.calls.filter((c) => /operator_bookings/.test(String(c[0])));
    expect(bookingCalls.length).toBeGreaterThan(0);
    for (const call of bookingCalls) {
      expect(String(call[0])).toMatch(/user_id\s*=\s*\$1/);
      expect(String(call[0])).not.toContain('tourist_email');
      expect(JSON.stringify(call[1])).not.toContain(EMAIL);
    }
  });

  it('числа берутся из туристической сводки, а не считаются заново', async () => {
    queryMock.mockResolvedValue({ rows: [{ total: '3', completed: '2', upcoming: '0', active: '0', spent: '7500', n: '0', avg: null }], rowCount: 1 });
    poolQueryMock.mockResolvedValue({ rows: [{ utility: '4', contribution: '9' }], rowCount: 1 });

    const res = await summary(new Request('http://localhost/api/tourist/summary'));
    const body = await res.json() as { ok: boolean; data: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.data.bookings_count).toBe(3);
    expect(body.data.bookings_completed).toBe(2);
    expect(body.data.total_spent).toBe(7500);
    expect(body.data.eco_utility).toBe(4);
    expect(body.data.eco_contribution).toBe(9);

    // Своего третьего способа считать в роуте нет — счёт живёт в общем модуле.
    const src = readFileSync(join(TOURIST_API, 'summary/route.ts'), 'utf-8');
    expect(src).toContain('touristTravelStats');
    expect(src).not.toMatch(/FROM operator_bookings/);
  });

  it('отказ базы: наружу род отказа, причина и SQLSTATE — в лог', async () => {
    const err = Object.assign(new Error('relation "operator_bookings" does not exist'), { code: '42P01' });
    queryMock.mockRejectedValue(err);
    poolQueryMock.mockResolvedValue({ rows: [{ utility: '0', contribution: '0' }], rowCount: 1 });

    const res = await summary(new Request('http://localhost/api/tourist/summary'));
    expect(res.status).toBe(500);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).not.toContain('does not exist');

    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0])).join('\n');
    expect(logged).toContain('42P01');
    expect(logged).toContain('tourist/summary');
  });
});
