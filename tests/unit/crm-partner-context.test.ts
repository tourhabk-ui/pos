/**
 * Сторож: «чей кабинет» решается одним правилом для шести ролей (CRM #2325).
 *
 * До CRM каждая роль искала своего партнёра по-своему, и исходы расходились:
 * пустой `catch` проката читал отказ базы как «профиля нет», гиду отдавался
 * null, агент ключевался по users.id. Здесь три исхода (§4.0) и ни одного
 * побочного действия: CRM профиль читает, а не заводит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requireRole = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const { ROLE_TO_CATEGORY, partnerContextFor, requirePartner } = await import('@/lib/crm/partner-context');
const { PARTNER_ROLES } = await import('@/lib/auth/role-routes');

const db = { query: (...a: unknown[]) => query(...a) } as unknown as Parameters<typeof partnerContextFor>[2];

beforeEach(() => {
  requireRole.mockReset();
  query.mockReset();
});

describe('роль → категория профиля', () => {
  it('каждая партнёрская роль знает свою категорию, и категории — из PARTNER_ROLES', () => {
    for (const role of PARTNER_ROLES) expect(ROLE_TO_CATEGORY[role], role).toBe(role);
    for (const cat of Object.values(ROLE_TO_CATEGORY)) expect(PARTNER_ROLES as readonly string[]).toContain(cat);
    expect(ROLE_TO_CATEGORY.transfer_operator).toBe('transfer');
    expect(ROLE_TO_CATEGORY.admin).toBeUndefined();
    expect(ROLE_TO_CATEGORY.tourist).toBeUndefined();
  });
});

describe('три исхода', () => {
  it('не партнёрская роль — «нет» без похода в базу', async () => {
    expect(await partnerContextFor('u1', 'tourist', db)).toEqual({ outcome: 'none', reason: 'role' });
    expect(query).not.toHaveBeenCalled();
  });

  it('профиль ищется по категории роли, самый ранний при задвоении', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'p-transfer', profile_status: null }] });
    expect(await partnerContextFor('u1', 'transfer_operator', db))
      .toEqual({ outcome: 'ok', partnerId: 'p-transfer', category: 'transfer', userId: 'u1' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['u1', 'transfer']);
    expect(sql).toMatch(/category = \$2/);
    expect(sql).toMatch(/ORDER BY created_at ASC NULLS LAST, id ASC/);
    expect(sql).not.toMatch(/INSERT|UPDATE/i);
  });

  it('профиля нет — «нет», а не создание на лету', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await partnerContextFor('u1', 'gear', db)).toEqual({ outcome: 'none', reason: 'profile' });
  });

  it('агент — только одобренный администратором', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'p-agent', profile_status: 'pending' }] });
    expect(await partnerContextFor('u1', 'agent', db)).toEqual({ outcome: 'none', reason: 'not_approved' });
    query.mockResolvedValueOnce({ rows: [{ id: 'p-agent', profile_status: 'approved' }] });
    expect(await partnerContextFor('u1', 'agent', db)).toMatchObject({ outcome: 'ok', partnerId: 'p-agent' });
  });

  it('база не ответила — «не смог», с SQLSTATE в логе, а не «профиля нет»', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockRejectedValueOnce(Object.assign(new Error('terminating'), { code: '57P01' }));
    expect(await partnerContextFor('u1', 'stay', db)).toEqual({ outcome: 'unavailable', reason: 'sqlstate 57P01' });
    expect(log.mock.calls.flat().join(' ')).toContain('57P01');
    log.mockRestore();
  });
});

describe('гард роутов', () => {
  const req = () => new NextRequest('http://localhost/api/hub/crm/contacts');

  it('пускает только партнёрские роли', async () => {
    requireRole.mockResolvedValueOnce(NextResponse.json({}, { status: 403 }));
    const r = await requirePartner(req());
    expect(r).toBeInstanceOf(NextResponse);
    expect((r as NextResponse).status).toBe(403);
    expect(requireRole.mock.calls[0][1]).toEqual([...PARTNER_ROLES]);
  });

  it('профиля нет — 403 с понятной причиной; база молчит — 503', async () => {
    requireRole.mockResolvedValue({ userId: 'u1', role: 'operator' });
    query.mockResolvedValueOnce({ rows: [] });
    const none = (await requirePartner(req())) as NextResponse;
    expect(none.status).toBe(403);
    expect((await none.json()).error).toMatch(/Профиль партнёра не найден/);

    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '08006' }));
    expect(((await requirePartner(req())) as NextResponse).status).toBe(503);
    log.mockRestore();
  });

  it('профиль есть — контекст с partnerId', async () => {
    requireRole.mockResolvedValue({ userId: 'u1', role: 'operator' });
    query.mockResolvedValueOnce({ rows: [{ id: 'p-op', profile_status: null }] });
    expect(await requirePartner(req())).toEqual({ outcome: 'ok', partnerId: 'p-op', category: 'operator', userId: 'u1' });
  });
});

/**
 * Профиль партнёра по человеку ищется С КАТЕГОРИЕЙ (10.10).
 *
 * `SELECT id FROM partners WHERE user_id = $1 LIMIT 1` отдаёт первую попавшуюся
 * строку человека. У того, у кого два профиля (оператор и гид, оператор и
 * агент), это может быть чужая категория — и инструменты броней оператора в
 * чате сайта уходили на профиль гида (app/api/ai/chat, починено переходом на
 * partnerContextFor). Перепись того же дня нашла форму ещё в девяти файлах.
 * Менять их вслепую нельзя: у старых операторов категория строки на проде не
 * сверена, и правка по категории могла бы отрезать живой календарь. Поэтому
 * долг заморожен списком, который только сокращается, — новый такой запрос
 * красный, починенный вычёркивается тем же коммитом.
 */
describe('поиск профиля по человеку — с категорией', () => {
  const KNOWN_WITHOUT_CATEGORY: Readonly<Record<string, string>> = {
    'app/api/carrier-trips/bookings/[id]/qr/route.ts': 'перевозчик; категория transfer на проде не сверена',
    'app/api/carrier-trips/bookings/route.ts': 'перевозчик; категория transfer на проде не сверена',
    'app/api/hub/operator/bookings-calendar/route.ts': 'календарь оператора; категория operator на проде не сверена',
    'app/api/operator-agreements/content-consent/route.ts': 'согласие оператора на контент; категория не сверена',
    'app/api/operator/calendar/block/route.ts': 'календарь оператора; категория operator на проде не сверена',
    'app/api/operator/calendar/bulk-open/route.ts': 'календарь оператора; категория operator на проде не сверена',
    'app/api/operator/calendar/ical/route.ts': 'календарь оператора; категория operator на проде не сверена',
    'app/api/operator/calendar/route.ts': 'календарь оператора; категория operator на проде не сверена',
    'lib/agents/agencies/guide-agency.ts': 'агентство гида; категория guide на проде не сверена',
  };

  async function lookupsWithoutCategory(): Promise<string[]> {
    const { execSync } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const files = execSync("git ls-files 'app' 'lib'", { encoding: 'utf-8' })
      .split('\n')
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    const out: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      const hit = [...src.matchAll(/`([^`]*)`/g)].some(([, sql]) =>
        /FROM\s+partners\b(?:\s+\w+)?\s+WHERE\s+(?:\w+\.)?user_id\s*=\s*\$1/.test(sql) && !sql.includes('category'));
      if (hit) out.push(f);
    }
    return out.sort();
  }

  it('новый поиск профиля без категории — красный', async () => {
    const added = (await lookupsWithoutCategory()).filter((f) => !(f in KNOWN_WITHOUT_CATEGORY));
    expect(added, 'Профиль по человеку — через partnerContextFor или с AND category = …').toEqual([]);
  });

  it('починенный вычёркивается из долга тем же коммитом', async () => {
    const current = await lookupsWithoutCategory();
    const stale = Object.keys(KNOWN_WITHOUT_CATEGORY).filter((f) => !current.includes(f));
    expect(stale).toEqual([]);
  });

  it('чат сайта ищет оператора по роли', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('app/api/ai/chat/route.ts', 'utf-8')).toMatch(/partnerContextFor\(userId, 'operator'\)/);
  });
});
