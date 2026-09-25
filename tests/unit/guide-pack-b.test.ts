/**
 * Кабинет гида, пакет B (25.09): работа гида и связка с оператором.
 *
 * Что держит этот сторож:
 *  1. Правила доступа на уровне роутов — оператор не назначит гида на чужую
 *     бронь и не назначит гида не из своей команды; гид отвечает только на своё
 *     приглашение; отклонённое приглашение членства не даёт; не в команде —
 *     ни групп, ни контактов туристов.
 *  2. Третий исход (§4.0): проверка календаря, которая не смогла выполниться,
 *     отвечает 503, а не «конфликт» и не «можно»; отказ базы на экране —
 *     ошибка, а не «пусто»; каждый отказ — в лог с SQLSTATE.
 *  3. Связку §10.09: у каждого статуса приглашения есть производитель, у
 *     partners.guide_operator_id и operator_bookings.guide_partner_id —
 *     ровно один писатель (lib/guides/team-queries.ts) и потребители.
 *  4. Сломанный SQL не возвращается: uuid = bigint, PostGIS без PostGIS,
 *     несуществующая check_schedule_conflicts, «все туры платформы» как
 *     «Мои туры».
 *
 * Форму самих запросов доказывает сервер — tests/integration/guide-team.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { TEAM_SQL, SCHEDULE_SQL } from '@/lib/guides/team-queries';
import { INVITE_STATUSES } from '@/lib/guides/team';
import { groupAssignments } from '@/lib/guides/groups';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

// ── Моки: база, авторизация, профили ─────────────────────────────────────────

type Handler = (params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>;
let handlers = new Map<string, Handler>();
const calls: Array<{ sql: string; params: unknown[] }> = [];

function run(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  const h = handlers.get(sql);
  if (!h) return Promise.reject(new Error(`unexpected SQL: ${sql.slice(0, 80)}`));
  try {
    return Promise.resolve(h(params));
  } catch (e) {
    return Promise.reject(e);
  }
}

vi.mock('@/lib/database', () => ({
  query: (sql: string, params?: unknown[]) => run(sql, params),
  transaction: async (cb: (c: { query: typeof run }) => Promise<unknown>) => cb({ query: run }),
}));

const GUIDE = '11111111-1111-4111-8111-111111111111';
const OTHER_GUIDE = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const OTHER_OPERATOR = '44444444-4444-4444-8444-444444444444';
const INVITE = '55555555-5555-4555-8555-555555555555';

vi.mock('@/lib/auth/middleware', () => ({
  requireRole: vi.fn(async () => ({ userId: 'user-1', role: 'guide' })),
  requireOperator: vi.fn(async () => ({ userId: 'user-op', role: 'operator' })),
}));
vi.mock('@/lib/auth/guide-helpers', () => ({ getGuidePartnerId: vi.fn(async () => GUIDE) }));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: vi.fn(async () => OPERATOR) }));

const sqlCalls = (sql: string) => calls.filter((c) => c.sql === sql);

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  handlers = new Map();
  calls.length = 0;
  errSpy?.mockRestore();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
const logged = () => errSpy.mock.calls.flat().map(String).join(' ');

// ── 1. Назначение гида на бронь — сторона оператора ──────────────────────────

describe('PUT /api/hub/operator/bookings/[id]/guide — назначение', () => {
  const put = async (id: string, body: unknown) => {
    const { PUT } = await import('@/app/api/hub/operator/bookings/[id]/guide/route');
    return PUT(jsonReq(`http://x/api/hub/operator/bookings/${id}/guide`, 'PUT', body), { params: Promise.resolve({ id }) });
  };
  const ownBooking = (status = 'confirmed') => handlers.set(TEAM_SQL.lockOperatorBooking, (p) => (
    p[0] === '42' && p[1] === OPERATOR
      ? { rows: [{ id: '42', guide_partner_id: null, booking_status: status, booking_date: '2026-10-01', tour_title: 'Тур' }] }
      : { rows: [] }
  ));
  const team = () => handlers.set(TEAM_SQL.teamGuide, (p) => (
    p[0] === GUIDE && p[1] === OPERATOR ? { rows: [{ id: GUIDE, user_id: 'guide-user' }] } : { rows: [] }
  ));

  it('чужая бронь неотличима от несуществующей: 404, запись не делается', async () => {
    ownBooking();
    team();
    const res = await put('77', { guidePartnerId: GUIDE });
    expect(res.status).toBe(404);
    expect(sqlCalls(TEAM_SQL.lockOperatorBooking)[0].params).toEqual(['77', OPERATOR]);
    expect(sqlCalls(TEAM_SQL.setBookingGuide)).toHaveLength(0);
  });

  it('гид не из команды оператора — 409, запись не делается', async () => {
    ownBooking();
    team();
    const res = await put('42', { guidePartnerId: OTHER_GUIDE });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/не состоит в вашей команде/);
    expect(sqlCalls(TEAM_SQL.teamGuide)[0].params).toEqual([OTHER_GUIDE, OPERATOR]);
    expect(sqlCalls(TEAM_SQL.setBookingGuide)).toHaveLength(0);
  });

  it('гид команды на свою бронь — назначен, уведомление без ПД туриста', async () => {
    ownBooking();
    team();
    handlers.set(TEAM_SQL.setBookingGuide, () => ({ rows: [{ id: '42', guide_partner_id: GUIDE }] }));
    handlers.set(TEAM_SQL.notify, () => ({ rows: [] }));
    const res = await put('42', { guidePartnerId: GUIDE });
    expect(res.status).toBe(200);
    expect(sqlCalls(TEAM_SQL.setBookingGuide)[0].params).toEqual(['42', GUIDE]);
    const note = sqlCalls(TEAM_SQL.notify)[0].params;
    expect(note[0]).toBe('guide-user');
    expect(JSON.stringify(note)).not.toMatch(/tourist|\+7\d/);
  });

  it('снять гида можно без проверки команды', async () => {
    ownBooking();
    handlers.set(TEAM_SQL.setBookingGuide, () => ({ rows: [{ id: '42', guide_partner_id: null }] }));
    const res = await put('42', { guidePartnerId: null });
    expect(res.status).toBe(200);
    // Было null → стало null: записи нет, но и отказа нет.
    expect(sqlCalls(TEAM_SQL.teamGuide)).toHaveLength(0);
  });

  it('закрытая бронь не переназначается', async () => {
    ownBooking('completed');
    team();
    const res = await put('42', { guidePartnerId: GUIDE });
    expect(res.status).toBe(409);
    expect(sqlCalls(TEAM_SQL.setBookingGuide)).toHaveLength(0);
  });

  it('некорректный id брони — 404 без запроса; отказ базы — 500 со следом', async () => {
    expect((await put('abc', { guidePartnerId: GUIDE })).status).toBe(404);
    expect(calls).toHaveLength(0);
    handlers.set(TEAM_SQL.lockOperatorBooking, () => { throw Object.assign(new Error('x'), { code: '40P01' }); });
    expect((await put('42', { guidePartnerId: GUIDE })).status).toBe(500);
    expect(logged()).toContain('sqlstate=40P01');
  });
});

// ── 2. Приглашение — сторона гида ────────────────────────────────────────────

describe('POST /api/guide/team — ответ на приглашение', () => {
  const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/guide/team/route');
    return POST(jsonReq('http://x/api/guide/team', 'POST', body));
  };
  const guideRow = (operatorId: string | null) => handlers.set(TEAM_SQL.lockGuide, () => ({ rows: [{ guide_operator_id: operatorId }] }));
  const myInvite = () => handlers.set(TEAM_SQL.lockPendingInviteForGuide, (p) => (
    p[0] === INVITE && p[1] === GUIDE ? { rows: [{ id: INVITE, operator_id: OPERATOR }] } : { rows: [] }
  ));
  beforeEach(() => {
    handlers.set(TEAM_SQL.respondInvite, () => ({ rows: [{ id: INVITE }] }));
    handlers.set(TEAM_SQL.setMembership, () => ({ rows: [{ id: GUIDE }] }));
  });

  it('приглашение ищется только среди своих: чужое — 404, членство не пишется', async () => {
    guideRow(null);
    handlers.set(TEAM_SQL.lockPendingInviteForGuide, () => ({ rows: [] }));
    const res = await post({ inviteId: INVITE, action: 'accept' });
    expect(res.status).toBe(404);
    expect(sqlCalls(TEAM_SQL.lockPendingInviteForGuide)[0].params).toEqual([INVITE, GUIDE]);
    expect(sqlCalls(TEAM_SQL.setMembership)).toHaveLength(0);
  });

  it('отклонение не даёт членства', async () => {
    guideRow(null);
    myInvite();
    const res = await post({ inviteId: INVITE, action: 'decline' });
    expect(res.status).toBe(200);
    expect(sqlCalls(TEAM_SQL.respondInvite)[0].params).toEqual([INVITE, 'declined']);
    expect(sqlCalls(TEAM_SQL.setMembership)).toHaveLength(0);
  });

  it('принятие пишет членство у оператора приглашения', async () => {
    guideRow(null);
    myInvite();
    const res = await post({ inviteId: INVITE, action: 'accept' });
    expect(res.status).toBe(200);
    expect(sqlCalls(TEAM_SQL.setMembership)[0].params).toEqual([GUIDE, OPERATOR]);
    expect(sqlCalls(TEAM_SQL.respondInvite)[0].params).toEqual([INVITE, 'accepted']);
  });

  it('в команде другого оператора — 409, членство не перезаписывается', async () => {
    guideRow(OTHER_OPERATOR);
    myInvite();
    const res = await post({ inviteId: INVITE, action: 'accept' });
    expect(res.status).toBe(409);
    expect(sqlCalls(TEAM_SQL.setMembership)).toHaveLength(0);
    expect(sqlCalls(TEAM_SQL.respondInvite)).toHaveLength(0);
  });
});

describe('DELETE /api/guide/team и /api/operator/guides — выход и исключение', () => {
  it('выход закрывает приглашение как left и снимает будущие назначения', async () => {
    handlers.set(TEAM_SQL.lockGuide, () => ({ rows: [{ guide_operator_id: OPERATOR }] }));
    handlers.set(TEAM_SQL.clearMembership, () => ({ rows: [{ id: GUIDE }] }));
    handlers.set(TEAM_SQL.closeAcceptedInvites, () => ({ rows: [] }));
    handlers.set(TEAM_SQL.unassignFutureBookings, () => ({ rows: [] }));
    const { DELETE } = await import('@/app/api/guide/team/route');
    const res = await DELETE(jsonReq('http://x/api/guide/team', 'DELETE'));
    expect(res.status).toBe(200);
    expect(sqlCalls(TEAM_SQL.closeAcceptedInvites)[0].params).toEqual([GUIDE, OPERATOR, 'left']);
    expect(sqlCalls(TEAM_SQL.unassignFutureBookings)[0].params).toEqual([GUIDE, OPERATOR]);
  });

  it('оператор исключает только своего: чужой — 404 без снятия назначений', async () => {
    handlers.set(TEAM_SQL.lockGuide, () => ({ rows: [{ guide_operator_id: OTHER_OPERATOR }] }));
    handlers.set(TEAM_SQL.clearMembership, (p) => (p[1] === OTHER_OPERATOR ? { rows: [{ id: GUIDE }] } : { rows: [] }));
    const { DELETE } = await import('@/app/api/operator/guides/route');
    const res = await DELETE(jsonReq('http://x/api/operator/guides', 'DELETE', { guideId: GUIDE }));
    expect(res.status).toBe(404);
    expect(sqlCalls(TEAM_SQL.clearMembership)[0].params).toEqual([GUIDE, OPERATOR]);
    expect(sqlCalls(TEAM_SQL.unassignFutureBookings)).toHaveLength(0);
  });

  it('исключение своего — приглашение revoked, будущие назначения сняты', async () => {
    handlers.set(TEAM_SQL.lockGuide, () => ({ rows: [{ guide_operator_id: OPERATOR }] }));
    handlers.set(TEAM_SQL.clearMembership, () => ({ rows: [{ id: GUIDE }] }));
    handlers.set(TEAM_SQL.closeAcceptedInvites, () => ({ rows: [] }));
    handlers.set(TEAM_SQL.unassignFutureBookings, () => ({ rows: [] }));
    const { DELETE } = await import('@/app/api/operator/guides/route');
    const res = await DELETE(jsonReq('http://x/api/operator/guides', 'DELETE', { guideId: GUIDE }));
    expect(res.status).toBe(200);
    expect(sqlCalls(TEAM_SQL.closeAcceptedInvites)[0].params).toEqual([GUIDE, OPERATOR, 'revoked']);
    expect(sqlCalls(TEAM_SQL.unassignFutureBookings)).toHaveLength(1);
  });
});

describe('POST/DELETE /api/operator/guides/invites — приглашения оператора', () => {
  const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/operator/guides/invites/route');
    return POST(jsonReq('http://x/api/operator/guides/invites', 'POST', body));
  };

  it('гид не найден по e-mail — 404, приглашение не создаётся', async () => {
    handlers.set(TEAM_SQL.findGuideByEmail, () => ({ rows: [] }));
    expect((await post({ email: 'nobody@example.com' })).status).toBe(404);
    expect(sqlCalls(TEAM_SQL.insertInvite)).toHaveLength(0);
  });

  it('уже в команде — 409; повтор ждущего — 409', async () => {
    handlers.set(TEAM_SQL.findGuideByEmail, () => ({ rows: [{ id: GUIDE, name: 'Гид', user_id: 'gu', guide_operator_id: OPERATOR }] }));
    expect((await post({ email: 'g@example.com' })).status).toBe(409);
    handlers.set(TEAM_SQL.findGuideByEmail, () => ({ rows: [{ id: GUIDE, name: 'Гид', user_id: 'gu', guide_operator_id: null }] }));
    handlers.set(TEAM_SQL.insertInvite, () => ({ rows: [] }));
    expect((await post({ email: 'g@example.com' })).status).toBe(409);
  });

  it('приглашение создаётся от имени оператора из JWT; гиду уходит уведомление', async () => {
    handlers.set(TEAM_SQL.findGuideByEmail, () => ({ rows: [{ id: GUIDE, name: 'Гид', user_id: 'gu', guide_operator_id: null }] }));
    handlers.set(TEAM_SQL.insertInvite, () => ({ rows: [{ id: INVITE }] }));
    handlers.set(TEAM_SQL.notify, () => ({ rows: [] }));
    expect((await post({ email: 'G@Example.com' })).status).toBe(200);
    expect(sqlCalls(TEAM_SQL.insertInvite)[0].params).toEqual([OPERATOR, GUIDE, 'user-1']);
    expect(sqlCalls(TEAM_SQL.notify)[0].params[0]).toBe('gu');
  });

  it('отзыв — только своего ждущего', async () => {
    handlers.set(TEAM_SQL.revokeInvite, () => ({ rows: [] }));
    const { DELETE } = await import('@/app/api/operator/guides/invites/route');
    const res = await DELETE(jsonReq('http://x/api/operator/guides/invites', 'DELETE', { inviteId: INVITE }));
    expect(res.status).toBe(404);
    expect(sqlCalls(TEAM_SQL.revokeInvite)[0].params).toEqual([INVITE, OPERATOR]);
  });
});

// ── 3. Группы и расписание гида ──────────────────────────────────────────────

describe('GET /api/guide/groups — назначенные брони', () => {
  it('не в команде — назначения с контактами не запрашиваются', async () => {
    handlers.set(TEAM_SQL.membership, () => ({ rows: [{ operator_id: null }] }));
    const { GET } = await import('@/app/api/guide/groups/route');
    const json = await (await GET(jsonReq('http://x/api/guide/groups', 'GET'))).json();
    expect(json.data).toEqual({ inTeam: false, groups: [] });
    expect(sqlCalls(TEAM_SQL.assignedUpcoming)).toHaveLength(0);
  });

  it('в команде — брони собраны по дате и туру, контакт — из брони', async () => {
    handlers.set(TEAM_SQL.membership, () => ({ rows: [{ operator_id: OPERATOR }] }));
    handlers.set(TEAM_SQL.assignedUpcoming, () => ({ rows: [
      { booking_id: '1', booking_date: '2026-10-01', end_date: null, participants: 2, booking_status: 'confirmed', tourist_name: 'А', tourist_phone: '+71', special_requests: null, tour_id: '7', tour_title: 'Тур', meeting_point: null, operator_name: 'О' },
      { booking_id: '2', booking_date: '2026-10-01', end_date: null, participants: 3, booking_status: 'new', tourist_name: 'Б', tourist_phone: null, special_requests: null, tour_id: '7', tour_title: 'Тур', meeting_point: null, operator_name: 'О' },
    ] }));
    const { GET } = await import('@/app/api/guide/groups/route');
    const json = await (await GET(jsonReq('http://x/api/guide/groups', 'GET'))).json();
    expect(sqlCalls(TEAM_SQL.assignedUpcoming)[0].params).toEqual([GUIDE]);
    expect(json.data.groups).toHaveLength(1);
    expect(json.data.groups[0]).toMatchObject({ totalParticipants: 5, tourTitle: 'Тур' });
    expect(json.data.groups[0].bookings[0].touristPhone).toBe('+71');
  });

  it('отказ базы — 500, а не «групп нет»', async () => {
    handlers.set(TEAM_SQL.membership, () => { throw Object.assign(new Error('x'), { code: '42883' }); });
    const { GET } = await import('@/app/api/guide/groups/route');
    const res = await GET(jsonReq('http://x/api/guide/groups', 'GET'));
    expect(res.status).toBe(500);
    expect(logged()).toContain('sqlstate=42883');
  });

  it('groupAssignments: разные туры одной даты — разные группы', () => {
    const base = { end_date: null, booking_status: 'confirmed', tourist_name: null, tourist_phone: null, special_requests: null, meeting_point: null, operator_name: null, tour_title: 'Т' };
    const g = groupAssignments([
      { ...base, booking_id: '1', booking_date: '2026-10-01', participants: 1, tour_id: '1' },
      { ...base, booking_id: '2', booking_date: '2026-10-01', participants: 1, tour_id: '2' },
    ]);
    expect(g).toHaveLength(2);
  });
});

describe('POST /api/guide/schedule — три исхода проверки', () => {
  const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/guide/schedule/route');
    return POST(jsonReq('http://x/api/guide/schedule', 'POST', body));
  };
  const valid = { date: '2026-10-01', startTime: '09:00', endTime: '11:00', title: 'Выход' };

  it('не смогли проверить пересечение — 503 и след в логе, а не «конфликт» и не запись', async () => {
    handlers.set(SCHEDULE_SQL.overlap, () => { throw Object.assign(new Error('x'), { code: '57014' }); });
    const res = await post(valid);
    expect(res.status).toBe(503);
    expect(logged()).toContain('sqlstate=57014');
    expect(sqlCalls(SCHEDULE_SQL.insert)).toHaveLength(0);
  });

  it('пересечение есть — 409; нет — запись с датой и местным временем', async () => {
    handlers.set(SCHEDULE_SQL.overlap, () => ({ rows: [{ id: 'x' }] }));
    expect((await post(valid)).status).toBe(409);
    handlers.set(SCHEDULE_SQL.overlap, () => ({ rows: [] }));
    handlers.set(SCHEDULE_SQL.insert, () => ({ rows: [{ id: 'new' }] }));
    expect((await post(valid)).status).toBe(200);
    const p = sqlCalls(SCHEDULE_SQL.insert)[0].params;
    expect(p.slice(0, 4)).toEqual([GUIDE, '2026-10-01', '09:00', '11:00']);
  });

  it('бронь, не назначенная гиду, — 404 без записи', async () => {
    handlers.set(SCHEDULE_SQL.bookingAssignedToGuide, () => ({ rows: [] }));
    const res = await post({ ...valid, operatorBookingId: '42' });
    expect(res.status).toBe(404);
    expect(sqlCalls(SCHEDULE_SQL.bookingAssignedToGuide)[0].params).toEqual(['42', GUIDE]);
    expect(sqlCalls(SCHEDULE_SQL.insert)).toHaveLength(0);
  });

  it('ISO-метка вместо ЧЧ:ММ и конец раньше начала — 400', async () => {
    expect((await post({ ...valid, startTime: '2026-10-01T09:00:00.000Z' })).status).toBe(400);
    expect((await post({ ...valid, endTime: '08:00' })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('GET: отказ базы — 500, а не пустой календарь', async () => {
    handlers.set(SCHEDULE_SQL.list, () => { throw Object.assign(new Error('x'), { code: '42P01' }); });
    handlers.set(TEAM_SQL.assignedInRange, () => ({ rows: [] }));
    const { GET } = await import('@/app/api/guide/schedule/route');
    const res = await GET(jsonReq('http://x/api/guide/schedule?dateFrom=2026-10-01&dateTo=2026-10-01', 'GET'));
    expect(res.status).toBe(500);
  });
});

describe('/api/guide/schedule/[id] — владение с третьим исходом', () => {
  const ID = '66666666-6666-4666-8666-666666666666';
  it('не смогли проверить владение — 503, не «не найдена»', async () => {
    handlers.set(SCHEDULE_SQL.ownership, () => { throw Object.assign(new Error('x'), { code: '08006' }); });
    const { GET } = await import('@/app/api/guide/schedule/[id]/route');
    const res = await GET(jsonReq(`http://x/api/guide/schedule/${ID}`, 'GET'), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(503);
    expect(logged()).toContain('sqlstate=08006');
  });
  it('чужая запись — 404; некорректный id — 404 без запроса', async () => {
    handlers.set(SCHEDULE_SQL.ownership, (p) => (p[1] === GUIDE ? { rows: [] } : { rows: [{ id: ID }] }));
    const { DELETE } = await import('@/app/api/guide/schedule/[id]/route');
    expect((await DELETE(jsonReq('http://x', 'DELETE'), { params: Promise.resolve({ id: ID }) })).status).toBe(404);
    calls.length = 0;
    expect((await DELETE(jsonReq('http://x', 'DELETE'), { params: Promise.resolve({ id: 'nope' }) })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

// ── 4. Связка §10.09 и ПД — по SQL ───────────────────────────────────────────

describe('связка: производители, писатели, ПД', () => {
  const migration = read('migrations/1018_guide_operator_team.sql');

  it('статусы приглашения в CHECK миграции = INVITE_STATUSES', () => {
    const m = migration.match(/CHECK \(status IN \(([^)]+)\)\)/);
    expect(m).toBeTruthy();
    const declared = (m as RegExpMatchArray)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(declared).toEqual([...INVITE_STATUSES]);
  });

  it('у каждого статуса есть производитель в коде', () => {
    const team = read('app/api/guide/team/route.ts');
    const opGuides = read('app/api/operator/guides/route.ts');
    // pending — значение по умолчанию при INSERT приглашения.
    expect(TEAM_SQL.insertInvite).toMatch(/INSERT INTO guide_operator_invites/);
    expect(migration).toMatch(/status\s+TEXT NOT NULL DEFAULT 'pending'/);
    expect(team).toMatch(/respondInvite, \[inviteId, 'accepted'\]/);
    expect(team).toMatch(/respondInvite, \[inviteId, 'declined'\]/);
    expect(team).toMatch(/closeAcceptedInvites, \[guideId, operatorId, 'left'\]/);
    expect(TEAM_SQL.revokeInvite).toMatch(/SET status = 'revoked'/);
    expect(opGuides).toMatch(/closeAcceptedInvites, \[guideId, partnerId, 'revoked'\]/);
  });

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
    }
    return out;
  }
  const code = [...walk('app'), ...walk('lib')];

  it('partners.guide_operator_id и operator_bookings.guide_partner_id пишутся только из team-queries', () => {
    const writers = code.filter((f) => /SET\s+guide_operator_id\s*=|SET\s+guide_partner_id\s*=/.test(read(f)));
    expect(writers).toEqual(['lib/guides/team-queries.ts']);
  });

  it('у назначения есть потребители: экран гида, «Гиды» оператора, карточка брони', () => {
    expect(TEAM_SQL.assignedUpcoming).toMatch(/b\.guide_partner_id = \$1/);
    expect(read('lib/operator/screen-queries.ts')).toMatch(/ob\.guide_partner_id = g\.id/);
    expect(read('app/api/hub/operator/bookings/[id]/route.ts')).toMatch(/g\.id = b\.guide_partner_id/);
    expect(read('app/hub/operator/bookings/[id]/_BookingDetailClient.tsx')).toMatch(/<GuideAssign/);
  });

  it('контакт туриста — только в назначениях гида действующей команды', () => {
    const withPd = Object.entries(TEAM_SQL).filter(([, sql]) => /tourist_(phone|name)/.test(sql)).map(([k]) => k);
    expect(withPd).toEqual(['assignedUpcoming']);
    expect(TEAM_SQL.assignedUpcoming).toMatch(/g\.guide_operator_id = t\.operator_id/);
    expect(TEAM_SQL.assignedInRange).not.toMatch(/tourist_/);
    expect(TEAM_SQL.notify).toMatch(/'normal'/);
  });
});

// ── 5. Сломанное не возвращается ─────────────────────────────────────────────

describe('сломанный SQL кабинета гида не возвращается', () => {
  const files = [
    'app/api/guide/tours/route.ts',
    'app/api/guide/groups/route.ts',
    'app/api/guide/schedule/route.ts',
    'app/api/guide/schedule/[id]/route.ts',
    'app/api/guide/team/route.ts',
    'lib/guides/team-queries.ts',
    'lib/guides/schedule.ts',
  ];

  it('в guide-helpers не осталось проверок календаря, глушивших отказ', () => {
    const src = read('lib/auth/guide-helpers.ts');
    for (const fn of ['checkScheduleConflicts', 'hasTourDayConflict', 'verifyScheduleOwnership']) {
      expect(src).not.toMatch(new RegExp(`export async function ${fn}\\b`));
    }
    expect(src).not.toMatch(/SELECT check_schedule_conflicts/);
  });

  it('/api/guide/map удалён вместе с getGuideExpertiseZones', () => {
    expect(existsSync(join(ROOT, 'app/api/guide/map/route.ts'))).toBe(false);
    expect(read('lib/auth/guide-helpers.ts')).not.toMatch(/export async function getGuideExpertiseZones/);
  });

  it.each(files)('%s: нет uuid = bigint, PostGIS, check_schedule_conflicts, legacy-колонок расписания', (f) => {
    const src = read(f);
    expect(src).not.toMatch(/operator_id = \$1::bigint/);
    expect(src).not.toMatch(/ST_(X|Y|MakePoint|SetSRID)\(/);
    expect(src).not.toMatch(/SELECT check_schedule_conflicts/);
    expect(src).not.toMatch(/gs\.(tour_id|booking_id)\b/);
    expect(src).not.toMatch(/includes_guide|includes_equipment/);
  });

  it('«Мои туры» не подменяются всеми турами платформы', () => {
    expect(read('app/api/guide/tours/route.ts')).not.toMatch(/IS NULL OR ot\.operator_id/);
    expect(TEAM_SQL.operatorTours).toMatch(/WHERE ot\.operator_id = \$1/);
  });

  const serverFiles = [
    ...files.filter((f) => f.startsWith('app/')),
    'app/api/operator/guides/route.ts',
    'app/api/operator/guides/invites/route.ts',
    'app/api/hub/operator/bookings/[id]/guide/route.ts',
    'lib/guides/schedule.ts',
    'lib/guides/team.ts',
  ];
  it.each(serverFiles)('%s: ни одного немого catch', (f) => {
    const src = read(f);
    // catch, сразу отвечающий/возвращающий без записи в лог.
    expect(src).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*(return|\})/);
    const catches = (src.match(/\}\s*catch\b/g) ?? []).length;
    const logs = (src.match(/log(Guide|ScreenQuery)Failure\(/g) ?? []).length;
    expect(logs).toBeGreaterThanOrEqual(catches - (src.match(/\.json\(\)\.catch\(/g) ?? []).length);
  });

  it('клиенты расписания и групп показывают ошибку, а не «пусто»', () => {
    for (const f of ['app/hub/guide/schedule/_GuideSchedulePageClient.tsx', 'app/hub/guide/groups/_GuideGroupsPageClient.tsx']) {
      const src = read(f);
      expect(src, f).toMatch(/const \{ data, loading, error, refetch \} = useApiFetch/);
      expect(src, f).toMatch(/\) : error \? \(/);
      expect(src, f).not.toMatch(/\.catch\(\(\) => \{\}\)/);
    }
  });
});
