/**
 * GET /api/hub/operator/widget и GET /api/admin/operators/[id]/widget/report
 * (аудит 15.10, находка WID-screens, W7) — вызовом роута на моке пула.
 *
 * Роли проверяет НАСТОЯЩИЙ requireRole: подменён только разбор токена
 * (getUserFromRequest), так что «не оператор — отказ» судит код гейта, а не
 * мок. Кабинет находит настоящий operatorAccess по SQL-связке до
 * partners.user_id (или команде): мок базы отвечает на запрос доступа по
 * user_id из параметров, как отвечала бы база.
 *
 * Держит:
 *  - оператор видит только СВОЕГО партнёра: id из адреса не читается, чужой
 *    id в запрос не уходит ни в каком параметре;
 *  - не-оператор — 403, без входа — 401, оператор без кабинета — 404, и база
 *    про партнёров при этом не спрашивается;
 *  - отказ базы на доступе или на самом партнёре — 503 и строка в логе с
 *    SQLSTATE, а не «данных нет»; отказ части — 200, часть null и названа;
 *  - в ответе только агрегаты: ни имени, ни телефона посетителя;
 *  - админский отчёт: только администратору, не-uuid — 400 до базы, сайты
 *    опрашиваются только по probe_sites=1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { poolQuery, getUser, dnsLookup } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  getUser: vi.fn(),
  dnsLookup: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: getUser }));
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup, default: { lookup: dnsLookup } }));

import { GET as operatorGET } from '@/app/api/hub/operator/widget/route';
import { GET as adminGET } from '@/app/api/admin/operators/[id]/widget/report/route';
import {
  PARTNER_WIDGET_SQL, TELEMETRY_SQL, CHAT_SESSIONS_SQL, FORM_LEADS_SQL, CHAT_PSEUDO_LEADS_SQL,
} from '@/lib/analytics/widget-census';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const MANAGER_A = '00000000-0000-4000-8000-0000000000a2';
const NOBODY = '00000000-0000-4000-8000-0000000000c1';
const PARTNER_A = '0aaa4f05-0000-4000-8000-00000000000a';
const PARTNER_B = '0bbb4f05-0000-4000-8000-00000000000b';

const PARTNERS: Record<string, { id: string; slug: string; name: string; widget_domains: string[]; widget_enabled: boolean }> = {
  [PARTNER_A]: { id: PARTNER_A, slug: 'mestechko', name: 'Местечко Камчатка', widget_domains: ['mestechkokam.ru'], widget_enabled: true },
  [PARTNER_B]: { id: PARTNER_B, slug: 'fishingkam', name: 'Камчатская рыбалка', widget_domains: ['fishingkam.ru'], widget_enabled: true },
};

/** Строка доступа — по user_id, как ответил бы ACCESS_SQL на базе. */
function accessRow(userId: string) {
  if (userId === USER_A) return { own_partner_id: PARTNER_A, member_partner_id: null, member_id: null, can_edit_prices: null, can_cancel_bookings: null, was_revoked: false };
  if (userId === USER_B) return { own_partner_id: PARTNER_B, member_partner_id: null, member_id: null, can_edit_prices: null, can_cancel_bookings: null, was_revoked: false };
  if (userId === MANAGER_A) return { own_partner_id: null, member_partner_id: PARTNER_A, member_id: 'm-1', can_edit_prices: false, can_cancel_bookings: false, was_revoked: false };
  return { own_partner_id: null, member_partner_id: null, member_id: null, can_edit_prices: null, can_cancel_bookings: null, was_revoked: false };
}

type Fail = Partial<Record<'access' | 'partner' | 'telemetry', unknown>>;

/** База: доступ по user_id, партнёр по id, части — по списку id. */
function db(fail: Fail = {}) {
  poolQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/WITH own AS/.test(sql)) {
      if (fail.access) throw fail.access;
      return { rows: [accessRow(String(params[0]))] };
    }
    if (sql === PARTNER_WIDGET_SQL) {
      if (fail.partner) throw fail.partner;
      const p = PARTNERS[String(params[0])];
      return { rows: p ? [p] : [] };
    }
    const ids = params[0] as string[];
    if (sql === TELEMETRY_SQL) {
      if (fail.telemetry) throw fail.telemetry;
      return { rows: ids.map((id) => ({ partner_id: id, host: PARTNERS[id]?.widget_domains[0] ?? null, widget: 'form', served: 7, opened: 2, last_day: '2026-10-15' })) };
    }
    if (sql === CHAT_SESSIONS_SQL) return { rows: [] };
    if (sql === FORM_LEADS_SQL) {
      return { rows: ids.map((id) => ({ partner_id: id, leads_30d: 1, leads_90d: 1, self_90d: 0, listed_90d: 1, unlisted_90d: 0, not_sent_90d: 0, origin_not_recorded_90d: 0, last_at: null })) };
    }
    if (sql === CHAT_PSEUDO_LEADS_SQL) return { rows: [] };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 80)}`);
  });
}

/** Все параметры, ушедшие в базу после проверки доступа. */
function partnerParams(): string[] {
  return poolQuery.mock.calls
    .filter(([sql]) => !/WITH own AS/.test(String(sql)))
    .flatMap(([, params]) => (params as unknown[] | undefined ?? []).flat().map(String));
}

const opReq = (qs = '') => new NextRequest(`https://vedarai.ru/api/hub/operator/widget${qs}`);
type Body = { success: boolean; error?: string; data?: Record<string, unknown> & { partner: Record<string, unknown> } };

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  poolQuery.mockReset();
  getUser.mockReset();
  dnsLookup.mockReset();
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); vi.unstubAllGlobals(); });

describe('кабинет оператора: только свой партнёр', () => {
  it('владелец видит своего партнёра; id чужого из адреса не уходит в базу ни в каком параметре', async () => {
    db();
    getUser.mockResolvedValue({ userId: USER_A, role: 'operator' });
    const res = await operatorGET(opReq(`?partner_id=${PARTNER_B}&id=${PARTNER_B}&partner=fishingkam&slug=fishingkam`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.data!.partner.slug).toBe('mestechko');
    const sent = partnerParams();
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent)).toEqual(new Set([PARTNER_A]));
    expect(JSON.stringify(body)).not.toContain('fishingkam');
  });

  it('два оператора — каждый своего, и ни один не видит чужого', async () => {
    db();
    getUser.mockResolvedValue({ userId: USER_B, role: 'operator' });
    const b = (await (await operatorGET(opReq(`?partner_id=${PARTNER_A}`))).json()) as Body;
    expect(b.data!.partner.slug).toBe('fishingkam');
    expect(new Set(partnerParams())).toEqual(new Set([PARTNER_B]));

    poolQuery.mockClear();
    getUser.mockResolvedValue({ userId: USER_A, role: 'operator' });
    const a = (await (await operatorGET(opReq(`?partner_id=${PARTNER_B}`))).json()) as Body;
    expect(a.data!.partner.slug).toBe('mestechko');
    expect(new Set(partnerParams())).toEqual(new Set([PARTNER_A]));
  });

  it('менеджер команды видит кабинет, в котором работает', async () => {
    db();
    getUser.mockResolvedValue({ userId: MANAGER_A, role: 'operator' });
    const res = await operatorGET(opReq());
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).data!.partner.slug).toBe('mestechko');
  });

  it('не оператор — 403, без входа — 401; база про партнёров не спрошена', async () => {
    db();
    for (const role of ['tourist', 'guide', 'agent', 'stay']) {
      getUser.mockResolvedValue({ userId: USER_A, role });
      expect((await operatorGET(opReq())).status, role).toBe(403);
    }
    getUser.mockResolvedValue(null);
    expect((await operatorGET(opReq())).status).toBe(401);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('оператор без кабинета — 404, отчёта ни о ком нет', async () => {
    db();
    getUser.mockResolvedValue({ userId: NOBODY, role: 'operator' });
    const res = await operatorGET(opReq(`?partner_id=${PARTNER_A}`));
    expect(res.status).toBe(404);
    expect(partnerParams()).toEqual([]);
  });

  it('администратор без своего кабинета не видит через этот роут чужого партнёра', async () => {
    db();
    getUser.mockResolvedValue({ userId: NOBODY, role: 'admin' });
    const res = await operatorGET(opReq(`?partner_id=${PARTNER_A}&operator_id=${PARTNER_A}`));
    expect(res.status).toBe(404);
    expect(partnerParams()).toEqual([]);
  });
});

describe('кабинет оператора: исходы базы', () => {
  it('доступ не проверился — 503, а не «нет данных»', async () => {
    db({ access: Object.assign(new Error('connection terminated'), { code: '57P01' }) });
    getUser.mockResolvedValue({ userId: USER_A, role: 'operator' });
    const res = await operatorGET(opReq());
    expect(res.status).toBe(503);
    expect(partnerParams()).toEqual([]);
  });

  it('партнёр не прочитался — 503, SQLSTATE в логе, наружу без подробностей', async () => {
    db({ partner: Object.assign(new Error('relation "partners" does not exist'), { code: '42P01' }) });
    getUser.mockResolvedValue({ userId: USER_A, role: 'operator' });
    const res = await operatorGET(opReq());
    expect(res.status).toBe(503);
    const body = (await res.json()) as Body;
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Не удалось загрузить данные виджета/);
    expect(JSON.stringify(body)).not.toContain('42P01');
    expect(log.mock.calls.flat().join(' ')).toContain('42P01');
  });

  it('отказ части — 200, часть null и названа, прочие на месте', async () => {
    db({ telemetry: Object.assign(new Error('canceling statement'), { code: '57014' }) });
    getUser.mockResolvedValue({ userId: USER_A, role: 'operator' });
    const res = await operatorGET(opReq());
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Body).data!;
    expect(data.telemetry_30d).toBeNull();
    expect(data.failed_measures).toEqual([{ measure: 'widget_daily', sqlstate: '57014' }]);
    expect(data.form_leads).toMatchObject({ leads_30d: 1 });
    expect(data.chat_sessions).toMatchObject({ sessions_30d: 0 });
  });

  it('в ответе только агрегаты и сведения о партнёре; сайт этим роутом не опрашивается', async () => {
    db();
    getUser.mockResolvedValue({ userId: USER_A, role: 'operator' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const data = ((await (await operatorGET(opReq('?probe_sites=1'))).json()) as Body).data!;
    expect(Object.keys(data).sort()).toEqual([
      'chat_pseudo_leads', 'chat_sessions', 'failed_measures', 'form_leads', 'notes',
      'partner', 'site_probe', 'telemetry_30d', 'window',
    ]);
    expect(Object.keys(data.partner).sort()).toEqual(['name', 'slug', 'widget_domains', 'widget_enabled']);
    expect(data.site_probe).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dnsLookup).not.toHaveBeenCalled();
    expect(JSON.stringify(data)).not.toMatch(/phone|email|contact_name|\+7\d{10}/);
  });
});

describe('админский отчёт о виджете', () => {
  const adminReq = (id: string, qs = '') => adminGET(
    new NextRequest(`https://vedarai.ru/api/admin/operators/${encodeURIComponent(id)}/widget/report${qs}`),
    { params: Promise.resolve({ id }) },
  );

  it('только администратору: оператор — 403, без входа — 401', async () => {
    db();
    getUser.mockResolvedValue({ userId: USER_A, role: 'operator' });
    expect((await adminReq(PARTNER_B)).status).toBe(403);
    getUser.mockResolvedValue(null);
    expect((await adminReq(PARTNER_B)).status).toBe(401);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('не-uuid — 400 до базы; неизвестный uuid — 404; отказ базы — 503', async () => {
    db();
    getUser.mockResolvedValue({ userId: NOBODY, role: 'admin' });
    expect((await adminReq('mestechko')).status).toBe(400);
    expect(poolQuery).not.toHaveBeenCalled();
    expect((await adminReq('11111111-1111-1111-1111-111111111111')).status).toBe(404);
    db({ partner: Object.assign(new Error('boom'), { code: '08006' }) });
    expect((await adminReq(PARTNER_A)).status).toBe(503);
    expect(log.mock.calls.flat().join(' ')).toContain('08006');
  });

  it('отчёт того партнёра, что в адресе; без probe_sites сайт не опрашивается — «не проверено»', async () => {
    db();
    getUser.mockResolvedValue({ userId: NOBODY, role: 'admin' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const data = ((await (await adminReq(PARTNER_B)).json()) as Body).data!;
    expect(data.partner.slug).toBe('fishingkam');
    expect(data.site_probe).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probe_sites=1 — проба главных тем же правилом, что у переписи', async () => {
    db();
    getUser.mockResolvedValue({ userId: NOBODY, role: 'admin' });
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const fetchSpy = vi.fn(async () => new Response(
      '<html><script src="https://vedarai.ru/api/widget/lead.js?partner=mestechko" defer></script></html>',
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    const data = ((await (await adminReq(PARTNER_A, '?probe_sites=1')).json()) as Body).data!;
    expect(data.site_probe).toEqual([
      { domain: 'mestechkokam.ru', url: 'https://mestechkokam.ru/', outcome: 'found', scripts: ['form'], http_status: 200, reason: null },
    ]);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://mestechkokam.ru/');
  });
});
