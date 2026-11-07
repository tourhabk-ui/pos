// @vitest-environment node
/**
 * Строки заявки в уведомлениях: неполный план не роняет, свободный ввод не
 * уходит в Telegram (ревью PR #3133).
 *
 * С PR #3133 напоминание оператору (`leads-followup`) печатает план заявки, а
 * план приходит в `source_data` публичной формы: `asPlanForLead` проверяет
 * только каркас. Неполный план ронял `planLeadLines`, а цикл крона обёрнут
 * одним `try` — прогон прерывался на этой заявке, и напоминания о прочих не
 * уходили. И строки плана, и название маршрута — свободный ввод: в заглушку
 * Telegram (там, где MAX недоступен) они идут только сквозь `redactPII`.
 * Вызовом обработчика и функции уведомления, а не чтением исходника.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const alertMock = vi.fn();
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => alertMock(...a) }));
vi.mock('@/lib/crm/events', () => ({ recordSourceEventQuietly: vi.fn(), statusChangeTitle: () => 'смена статуса' }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { GET } from '@/app/api/cron/leads-followup/route';
import { FOLLOWUP_LEADS_SQL } from '@/lib/leads/followup-scope';
import { tripRequestLines, tripFactsOf, PLAN_UNREADABLE } from '@/lib/planner/trip-request-lines';
import { notifyAdminNewLead } from '@/lib/notifications/telegram-channel';

const PHONE = '+7 914 123-45-67';
/** Каркас плана есть (его и проверяет asPlanForLead), а состава группы нет — planLeadLines падает. */
const BROKEN_PLAN = { v: 1, party: {}, days: [], estimate: {} };
/** Полный план, в названии дня — телефон (свободный ввод публичной формы). */
const PHONE_PLAN = {
  v: 1, party: { adults: 2, children: [] }, budget_tier: 'standard',
  estimate: { total: [100000, 150000], per_person: [50000, 75000], unpriced: [] },
  days: [{ day: 1, title: `Звоните ${PHONE}`, tour: { id: 12, operator: 'Оператор', price: 13000, unit: 'person' } }],
};
const BROKEN = { id: 'l-broken', name: 'Анна', phone: '+79990000001', source_data: { interests: ['volcano'], plan: BROKEN_PLAN }, pd_consent_version: '2026-09-01' };
const NEXT = { id: 'l-next', name: 'Вера', phone: '+79990000002', source_data: { interests: ['volcano'], plan: PHONE_PLAN, date_from: '2027-07-10' }, pd_consent_version: '2026-09-01' };
const OPERATOR = { name: 'Туроператор', slug: 'tour-op', telegram_chat_id: '777', user_telegram_id: null, max_chat_id: '555' };

const savedSecret = process.env.CRON_SECRET;
beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  alertMock.mockReset();
  alertMock.mockResolvedValue({ delivered: true, channel: 'max', reason: 'ok' });
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (sql === FOLLOWUP_LEADS_SQL) return { rows: [BROKEN, NEXT] };
    if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: '1', with_telegram: '1', with_max: '1' }] };
    if (/FROM partners p/.test(sql)) return { rows: [OPERATOR] };
    return { rows: [] };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

describe('строки заявки: неполный план', () => {
  it('не падают, а называют план непрочитанным и пишут причину в лог', () => {
    const lines = tripRequestLines(tripFactsOf({ date_from: '2027-07-10', plan: BROKEN_PLAN }));
    expect(lines).toContain(PLAN_UNREADABLE);
    expect(lines[0]).toMatch(/^Даты: 10\.07\.2027/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('план заявки не прочитался'), expect.anything());
  });
});

describe('напоминание оператору (leads-followup)', () => {
  it('заявка с неполным планом не останавливает напоминания о следующих', async () => {
    const res = await GET(new NextRequest('https://vedarai.ru/api/cron/leads-followup', { headers: { authorization: 'Bearer test-secret' } }));
    expect(res.status).toBe(200);
    const sentFor = alertMock.mock.calls.map((c) => String((c[0] as { text: string }).text));
    expect(sentFor.some((t) => t.includes('l-broken') || t.includes(PLAN_UNREADABLE))).toBe(true);
    expect(sentFor.some((t) => t.includes('Звоните'))).toBe(true);
  });

  it('свободный ввод плана в заглушку Telegram уходит без телефона; в MAX — как есть', async () => {
    await GET(new NextRequest('https://vedarai.ru/api/cron/leads-followup', { headers: { authorization: 'Bearer test-secret' } }));
    const call = alertMock.mock.calls.map((c) => c[0] as { text: string; stub: string }).find((a) => a.text.includes('Звоните'));
    expect(call, 'напоминание о заявке с планом').toBeDefined();
    expect(call!.stub).toContain('Звоните');
    expect(call!.stub).not.toContain('123-45-67');
    expect(call!.text).toContain('123-45-67');
  });
});

describe('уведомление менеджеру о новой заявке', () => {
  const fetchMock = vi.fn();
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD_ENV };
  });

  it('заглушка: маршрут и план — без телефона; число дней — только числом', async () => {
    await notifyAdminNewLead({
      id: 'lead-x', name: 'Тест', phone: '+70000000000', comment: null, routeTitle: `Авачинский, ${PHONE}`, sourceUrl: null,
      score: 60, labelRu: 'Тёплый', sourceData: { source: 'trip_planner', plan: PHONE_PLAN, trip_days: 'звоните 89141234567' },
    });
    const [arg] = alertMock.mock.calls.at(-1) as [{ text: string; stub: string }];
    expect(arg.stub).toContain('Маршрут: Авачинский');
    expect(arg.stub).toContain('Звоните');
    expect(arg.stub).not.toMatch(/123-45-67|89141234567/);
    expect(arg.text).not.toContain('Длина:');
  });

  it('неполный план не роняет уведомление: строка «не прочитался» и причина в лог', async () => {
    await expect(notifyAdminNewLead({
      id: 'lead-y', name: 'Тест', phone: '+70000000000', comment: null, routeTitle: null, sourceUrl: null,
      score: 60, labelRu: 'Тёплый', sourceData: { source: 'trip_planner', plan: BROKEN_PLAN },
    })).resolves.not.toThrow();
    const [arg] = alertMock.mock.calls.at(-1) as [{ text: string; stub: string }];
    expect(arg.stub).toContain(PLAN_UNREADABLE);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('план заявки не прочитался'), expect.anything());
  });
});
