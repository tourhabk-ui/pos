/**
 * Сторож: заявка уходит с планом целиком (#2304, шаг 2).
 *
 * Из /planner в лид шли названия дней (`day_plan`) — без состава группы,
 * уровня, туров и цен, и этих полей не читал никто. MCP-заявка по плану Кузьмича
 * уходила одним комментарием. Теперь одна сводка (lib/planner/plan-for-lead):
 * её шлют /planner и MCP по plan_id, читают карточка лида в админке и
 * уведомление в Телеграм — одними словами.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let DRAFT: unknown = { kind: 'missing' };
const loadDraft = vi.fn(async () => DRAFT);
vi.mock('@/lib/planner/plan-drafts', () => ({
  loadDraft: (id: string) => loadDraft(id),
  isDraftId: (raw: string | undefined) => typeof raw === 'string' && /^[0-9a-f-]{36}$/.test(raw),
}));

import { planForLead, planLeadLines, asPlanForLead, type PlanLeadInputDay } from '@/lib/planner/plan-for-lead';
import { estimateGroup } from '@/lib/planner/estimate';
import { planFromDraft, planSourceFields, planAttachNote } from '@/lib/leads/plan-from-draft';
import { notifyAdminNewLead } from '@/lib/notifications/telegram-channel';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');
const plain = (s: string) => s.replace(/ /g, ' ');

const day = (n: number, type: PlanLeadInputDay['type'], extra: Partial<PlanLeadInputDay> = {}): PlanLeadInputDay => ({
  day: n, type, zone: 'western', title: `День ${n}`, priceFrom: 0, priceTo: 0, ...extra,
});
const DAYS: PlanLeadInputDay[] = [
  day(1, 'arrival', { zone: 'avachinsky', title: 'Прилёт' }),
  day(2, 'activity', {
    title: 'Недельный рыболовный тур', realPrice: 196000, availableDate: '2027-08-03',
    realTour: { tourId: '11', priceUnit: 'per_tour', maxParticipants: 8, lodgingIncluded: true, operatorName: 'Камчатская рыбалка' },
  }),
  day(3, 'activity', { title: 'Недельный рыболовный тур — день 2 из 7', realTour: { tourId: '11', priceUnit: 'per_tour', lodgingIncluded: true } }),
  day(4, 'activity', {
    zone: 'avachinsky', title: 'Вулкан Плоский Толбачик',
    priceMissing: 'Для группы из 3 чел. цену называет оператор отдельно: оставьте заявку, и он пришлёт её.',
    realTour: { tourId: '41', priceUnit: 'per_person', maxParticipants: 15, lodgingIncluded: null, operatorName: 'Край Вулканов' },
  }),
  day(5, 'departure', { zone: 'avachinsky', title: 'Вылет' }),
];
const PROFILE = { adults: 2, children: [6], budgetTier: 'comfort' as const, tripOrigin: 'visitor' as const, arrivalDate: '2027-08-02' };

describe('сводка плана для заявки', () => {
  const plan = planForLead(DAYS, PROFILE);

  it('состав, уровень, откуда едут, дата начала', () => {
    expect(plan).toMatchObject({ v: 1, party: { adults: 2, children: [6] }, budget_tier: 'comfort', trip_origin: 'visitor', arrival: '2027-08-02' });
  });

  it('у дня — дата, у тура — оператор, цена с единицей или причина, что цены нет', () => {
    expect(plan.days.map((d) => d.date)).toEqual(['2027-08-02', '2027-08-03', '2027-08-04', '2027-08-05', '2027-08-06']);
    expect(plan.days[1]!.tour).toEqual({ id: '11', operator: 'Камчатская рыбалка', price: 196000, unit: 'per_tour', available_date: '2027-08-03' });
    expect(plan.days[2]).toMatchObject({ continues_tour: true });
    expect(plan.days[2]!.tour).toBeUndefined();
    expect(plan.days[3]!.tour).toMatchObject({ id: '41', price_missing: expect.stringMatching(/цену называет оператор/) });
    expect(plan.days[3]!.tour!.price).toBeUndefined();
  });

  it('смета — та же формула, что на экране', () => {
    const e = estimateGroup(DAYS, PROFILE);
    expect(plan.estimate.total).toEqual(e.total);
    expect(plan.estimate.per_person).toEqual(e.perPerson);
    expect(plan.estimate.unpriced).toEqual(e.unpriced);
    expect(plan.estimate.lines).toHaveLength(e.lines.length);
  });

  it('персональных данных в сводке нет', () => {
    expect(JSON.stringify(plan)).not.toMatch(/"(name|phone|email)"/);
  });

  it('словами: состав, смета и туры по дням', () => {
    const lines = planLeadLines(plan).map(plain);
    expect(lines[0]).toBe('Группа: 2 взр., ребёнок 6 лет · уровень «комфорт»');
    expect(lines[1]).toMatch(/^Смета: [\d ]+ ₽–[\d ]+ ₽ на группу \([\d ]+ ₽–[\d ]+ ₽ на человека\) · без цены: 1$/);
    expect(lines).toContain('День 2 (03.08): «Недельный рыболовный тур» (ID11), Камчатская рыбалка, 196 000 ₽/группа, свободно с 03.08');
    expect(lines).toContain('День 4 (05.08): «Вулкан Плоский Толбачик» (ID41), Край Вулканов, цену называет оператор');
    expect(lines.some((l) => l.includes('день 2 из 7'))).toBe(false);
  });

  it('чужую форму не принимает за план', () => {
    expect(asPlanForLead(plan)).toBe(plan);
    expect(asPlanForLead(null)).toBeNull();
    expect(asPlanForLead({ days: [] })).toBeNull();
    expect(asPlanForLead([{ day: 1, title: 'x' }])).toBeNull();
  });
});

describe('MCP: план по plan_id', () => {
  const ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
  beforeEach(() => { loadDraft.mockClear(); });

  it('приложен — сводка и номер плана в source_data, агенту говорить нечего', async () => {
    DRAFT = { kind: 'found', draft: { id: ID, revision: 1, days: DAYS, params: {
      interests: ['fishing'], arrivalDate: '2027-08-02', departureDate: '2027-08-06', adults: 3, children: [], budgetTier: 'economy',
    } } };
    const a = await planFromDraft(ID);
    expect(a.kind).toBe('attached');
    const fields = planSourceFields(a) as { plan_id: string; plan: { party: unknown; budget_tier: string } };
    expect(fields.plan_id).toBe(ID);
    expect(fields.plan.party).toEqual({ adults: 3, children: [] });
    expect(fields.plan.budget_tier).toBe('economy');
    expect(planAttachNote(a)).toBe('');
  });

  it('плана нет — заявка без плана, и агент это слышит', async () => {
    DRAFT = { kind: 'missing' };
    const a = await planFromDraft(ID);
    expect(planSourceFields(a)).toEqual({});
    expect(planAttachNote(a)).toMatch(/не найден .* заявка принята без плана/);
  });

  it('база не ответила — заявка без плана, номер плана записан', async () => {
    DRAFT = { kind: 'failed' };
    const a = await planFromDraft(ID);
    expect(planSourceFields(a)).toEqual({ plan_id: ID });
    expect(planAttachNote(a)).toMatch(/не прочитался/);
  });

  it('не ID вовсе — в базу не ходит; нет plan_id — нет и разговора о плане', async () => {
    expect((await planFromDraft('мой план')).kind).toBe('missing');
    expect(loadDraft).not.toHaveBeenCalled();
    const none = await planFromDraft(undefined);
    expect(planSourceFields(none)).toEqual({});
    expect(planAttachNote(none)).toBe('');
  });
});

describe('уведомление в Телеграм несёт план', () => {
  const fetchMock = vi.fn();
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '123';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD_ENV };
  });

  it('состав, смета и туры — те же строки, что в админке, с экранированием', async () => {
    const plan = planForLead(DAYS.map((d) => (d.day === 2 ? { ...d, title: 'Тур <b>опасный</b>' } : d)), PROFILE);
    await notifyAdminNewLead({
      id: 'lead-plan', name: 'Тест', phone: '+70000000000', comment: null, routeTitle: null, sourceUrl: null,
      score: 60, labelRu: 'Тёплый', sourceData: { source: 'trip_planner', plan },
    });
    const body = plain(fetchMock.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.body ?? '')).join('\n'));
    expect(body).toContain('Группа: 2 взр., ребёнок 6 лет');
    expect(body).toMatch(/Смета: [\d ]+ ₽/);
    expect(body).toContain('цену называет оператор');
    expect(body).not.toContain('<b>опасный</b>');
  });
});

describe('связка: производители и потребители сводки', () => {
  it('/planner шлёт план целиком вместо названий дней', () => {
    const c = read('app/planner/_PlannerClient.tsx');
    expect(c).toMatch(/plan: planForLead\(days, \{ \.\.\.planProfile, arrivalDate: arrival \|\| null \}\)/);
    expect(c).not.toMatch(/day_plan:/);
  });

  it('админка показывает план теми же словами', () => {
    const c = read('app/hub/admin/leads/_LeadsClient.tsx');
    expect(c).toMatch(/asPlanForLead\(sd\.plan\)/);
    expect(c).toMatch(/planLeadLines\(plan\)/);
  });

  it('MCP: обе заявки принимают plan_id и говорят, если план не приложился', () => {
    const route = read('app/api/mcp/route.ts');
    expect(route.match(/planFromDraft\(parsed\.data\.plan_id\)/g)).toHaveLength(2);
    expect(route.match(/planAttachNote\(planAttach\)/g)).toHaveLength(2);
    expect(route.match(/plan_id: z\.string\(\)/g)).toHaveLength(2);
    const tools = read('lib/mcp/public-tools.ts');
    expect(tools.match(/plan_id: \{ type: 'string'/g)).toHaveLength(2);
  });
});
