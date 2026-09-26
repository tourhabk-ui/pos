/**
 * Объект жилья — на витрине только после одобрения администратором
 * (решение владельца 26.09, миграция 1027).
 *
 * До этого дня POST /api/stay/accommodations вставлял объект с
 * is_active = true, а витрина фильтровала только по is_active: новый объект
 * публиковался в ту же секунду, а экран владельца обещал «появится после
 * проверки» — проверки не было, is_verified не выставлял никто.
 *
 * Сторож держит связку целиком:
 *   производитель pending   — владелец создаёт объект на проверке;
 *   решение                 — админ одобряет/отклоняет (причина обязательна),
 *                             «Проверено» — только из одобрения;
 *   потребители             — каждый читатель витрины спрашивает одобрение;
 *   бронь                   — триггер в базе не пускает неодобренный объект;
 *   владелец                — видит статус и причину, правка отказа
 *                             возвращает объект на проверку.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';

const queryMock = vi.fn();
const poolQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

const requireAuthMock = vi.fn();
const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
  requireRole: (...args: unknown[]) => requireAuthMock(...args),
}));
vi.mock('@/lib/auth/partner-profile', () => ({
  ensurePartnerForRole: vi.fn().mockResolvedValue('partner-1'),
}));

import { publicAccommodationSql, ownerListingState } from '@/lib/stay/moderation';
import { POST as createAccommodation } from '@/app/api/stay/accommodations/route';
import { GET as publicList } from '@/app/api/accommodations/route';
import { GET as publicDetail, PATCH as patchAccommodation } from '@/app/api/accommodations/[id]/route';
import { PATCH as adminDecide } from '@/app/api/admin/accommodations/[id]/route';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';

function req(url: string, method: string, body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}
const read = (p: string) => readFileSync(p, 'utf-8');

beforeEach(() => {
  queryMock.mockReset();
  poolQueryMock.mockReset();
  requireAuthMock.mockReset();
  requireAdminMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'user-1', email: 'o@x.ru', role: 'stay' });
  requireAdminMock.mockResolvedValue({ userId: ADMIN_ID, email: 'a@x.ru', role: 'admin' });
});

describe('условие витрины', () => {
  it('одобрение И выключатель владельца', () => {
    const sql = publicAccommodationSql('a');
    expect(sql).toContain("a.moderation_status = 'approved'");
    expect(sql).toContain('a.is_active = true');
    expect(publicAccommodationSql('')).toContain("moderation_status = 'approved'");
    expect(() => publicAccommodationSql('a; DROP')).toThrow();
  });

  it('каждый читатель витрины жилья спрашивает одобрение, а не только is_active', () => {
    const readers = [
      'app/api/accommodations/route.ts',
      'app/api/accommodations/[id]/route.ts',
      'app/accommodations/[id]/page.tsx',
      'app/api/trip/plan/route.ts',
      'lib/kuzmich/accommodation-search.ts',
      'lib/seo/sitemap-entries.ts',
      'app/api/cron/planner-material-census/route.ts',
    ];
    for (const f of readers) {
      expect(read(f), f).toContain('publicAccommodationSql(');
    }
  });
});

describe('владелец создаёт объект — на проверке', () => {
  it('INSERT пишет moderation_status = pending, ответ не обещает публикацию', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'partner-1' }] });
      if (sql.includes('INSERT INTO accommodations')) return Promise.resolve({ rows: [{ id: ACC_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    const res = await createAccommodation(req('http://localhost/api/stay/accommodations', 'POST', {
      name: 'Дом у вулкана', description: 'Тёплый дом у подножия', type: 'guesthouse',
      coordinates: { lat: 53, lng: 158 },
    }));
    expect(res.status).toBe(201);
    const insert = String(queryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO accommodations'))![0]);
    expect(insert).toMatch(/moderation_status/);
    expect(insert).toMatch(/'pending'/);
    expect(insert).not.toMatch(/'approved'/);
    const body = await res.json() as { message: string; data: { moderationStatus: string } };
    expect(body.data.moderationStatus).toBe('pending');
    expect(body.message).toMatch(/проверк/);
  });

  it('миграция: умолчание pending, существующие одобрены, триггер брони', () => {
    const m = read('migrations/1027_accommodation_moderation.sql');
    expect(m).toMatch(/SET DEFAULT 'pending'/);
    expect(m).toMatch(/SET moderation_status = 'approved'\s+WHERE moderation_status IS NULL/);
    expect(m).toMatch(/BEFORE INSERT ON accommodation_bookings/);
    expect(m).toMatch(/moderation_status = 'approved'/);
  });
});

describe('витрина не показывает неодобренное', () => {
  it('список: и count, и выборка — с условием одобрения', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ total: '0' }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await publicList(req('http://localhost/api/accommodations', 'GET'));
    expect(res.status).toBe(200);
    expect(queryMock.mock.calls.length).toBe(2);
    for (const [sql] of queryMock.mock.calls) {
      expect(String(sql)).toContain("a.moderation_status = 'approved'");
    }
  });

  it('карточка и «похожие» — с условием одобрения', async () => {
    queryMock.mockImplementation(() => Promise.resolve({ rows: [] }));
    const res = await publicDetail(req(`http://localhost/api/accommodations/${ACC_ID}`, 'GET'),
      { params: Promise.resolve({ id: ACC_ID }) });
    expect(res.status).toBe(404);
    expect(String(queryMock.mock.calls[0][0])).toContain("a.moderation_status = 'approved'");
    const src = read('app/api/accommodations/[id]/route.ts');
    expect(src.match(/publicAccommodationSql\('a'\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('решение администратора', () => {
  it('одобрение: approved + «Проверено» + кто и когда', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ id: ACC_ID, name: 'Дом', moderation_status: 'approved', is_verified: true, is_active: true }] });
    const res = await adminDecide(req(`http://localhost/api/admin/accommodations/${ACC_ID}`, 'PATCH', { action: 'approve' }),
      { params: Promise.resolve({ id: ACC_ID }) });
    expect(res.status).toBe(200);
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/moderated_at\s+= NOW\(\)/);
    expect(params).toEqual([ACC_ID, 'approved', null, true, ADMIN_ID]);
  });

  it('отказ без причины — 400, в базу не идёт', async () => {
    const res = await adminDecide(req(`http://localhost/api/admin/accommodations/${ACC_ID}`, 'PATCH', { action: 'reject' }),
      { params: Promise.resolve({ id: ACC_ID }) });
    expect(res.status).toBe(400);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('отказ с причиной: rejected, «Проверено» снимается', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ id: ACC_ID, name: 'Дом', moderation_status: 'rejected', is_verified: false, is_active: true }] });
    const res = await adminDecide(req(`http://localhost/api/admin/accommodations/${ACC_ID}`, 'PATCH',
      { action: 'reject', reason: 'Нет ни одного фото объекта' }),
      { params: Promise.resolve({ id: ACC_ID }) });
    expect(res.status).toBe(200);
    const params = poolQueryMock.mock.calls[0][1] as unknown[];
    expect(params).toEqual([ACC_ID, 'rejected', 'Нет ни одного фото объекта', false, ADMIN_ID]);
  });

  it('не админ — отказ гейта, в базу не идёт', async () => {
    requireAdminMock.mockResolvedValue(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
    const res = await adminDecide(req(`http://localhost/api/admin/accommodations/${ACC_ID}`, 'PATCH', { action: 'approve' }),
      { params: Promise.resolve({ id: ACC_ID }) });
    expect(res.status).toBe(403);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('объект, заведённый самим администратором, — сразу одобрен (его решение), но без «Проверено»', () => {
    const src = read('app/api/accommodations/create/route.ts');
    expect(src).toMatch(/moderation_status, moderated_at, moderated_by/);
    expect(src).toMatch(/'approved', NOW\(\), \$20::uuid/);
    expect(src).not.toMatch(/is_verified/);
  });

  it('«Проверено» у жилья ставит только решение администратора', () => {
    // Владелец создаёт с is_verified = false; PATCH владельца is_verified не знает.
    expect(read('app/api/stay/accommodations/route.ts')).toMatch(/true, false, 'pending'/);
    expect(read('app/api/accommodations/[id]/route.ts')).not.toMatch(/is_verified\s*=/);
  });
});

describe('владелец видит статус; правка отказа — снова на проверку', () => {
  it('статусы для кабинета', () => {
    expect(ownerListingState({ is_active: true, moderation_status: 'pending', moderation_reason: null }))
      .toMatchObject({ label: 'На проверке', public: false });
    expect(ownerListingState({ is_active: true, moderation_status: 'approved', moderation_reason: null }))
      .toMatchObject({ label: 'Опубликовано', public: true });
    expect(ownerListingState({ is_active: false, moderation_status: 'approved', moderation_reason: null }).public).toBe(false);
    const rej = ownerListingState({ is_active: true, moderation_status: 'rejected', moderation_reason: 'нет фото' });
    expect(rej.label).toBe('Отклонено');
    expect(rej.detail).toContain('нет фото');
    expect(ownerListingState({ is_active: true, moderation_status: 'weird', moderation_reason: null }).public).toBe(false);
  });

  it('содержательная правка владельца возвращает rejected → pending; выключатель — нет', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('JOIN partners p')) return Promise.resolve({ rows: [{ id: ACC_ID }] });
      if (sql.startsWith('UPDATE accommodations')) return Promise.resolve({ rows: [{ id: ACC_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    await patchAccommodation(req(`http://localhost/api/accommodations/${ACC_ID}`, 'PATCH', { name: 'Новое имя' }),
      { params: Promise.resolve({ id: ACC_ID }) });
    const upd1 = String(queryMock.mock.calls.find(([s]) => String(s).startsWith('UPDATE accommodations'))![0]);
    expect(upd1).toMatch(/WHEN moderation_status = 'rejected' THEN 'pending'/);

    queryMock.mockClear();
    await patchAccommodation(req(`http://localhost/api/accommodations/${ACC_ID}`, 'PATCH', { isActive: false }),
      { params: Promise.resolve({ id: ACC_ID }) });
    const upd2 = String(queryMock.mock.calls.find(([s]) => String(s).startsWith('UPDATE accommodations'))![0]);
    expect(upd2).not.toMatch(/moderation_status/);
  });

  it('админ в кабинете: пункт меню и ссылка из очереди операторов', () => {
    expect(read('app/hub/admin/layout.tsx')).toContain("href: '/hub/admin/accommodations'");
    expect(read('app/hub/admin/operators/_OperatorsClient.tsx')).toContain('/hub/admin/accommodations');
    expect(read('app/hub/admin/accommodations/_AccommodationModerationClient.tsx')).toContain('/api/admin/accommodations');
  });
});
