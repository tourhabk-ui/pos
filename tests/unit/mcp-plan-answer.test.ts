/**
 * Ответ плана поездки внешнему агенту — живая проверка MCP прода 22.10
 * (версия 2.5.0), четыре находки, все — через тот же путь, что MCP:
 * `tools/call` роута /api/mcp с подменённой базой.
 *
 *  1. Ссылка «Продолжить в Ведаре» шла отдельным элементом content без
 *     разделителя. Клиент, склеивающий элементы, получал
 *     «…/trip/<id>Продолжить в Ведаре: …», и автоссылка забирала слово в адрес
 *     страницы плана.
 *  2. Агент передал children: "2", считая это числом детей; сервер прочёл
 *     «ребёнок 2 лет», считал на троих вместо четверых, и из ответа этого не
 *     было видно. Агенту (MCP и A2A) строка группы называет людей числом и
 *     прочтение поля; в чате туриста этой пометки нет.
 *  3. flight_delay отвечал «Выпали дни 2; остальные дни не менялись» — без
 *     числа, даты, занятия и причины.
 *  4. Строка «Изменить — edit_trip_plan …» не называла задержку рейса.
 *
 * Ревью той же правки: одиночный children «0» (и массив [0]) у агента —
 * младенец до года, а не «детей нет» молча; в чате туриста — как прежде.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { DayPlan } from '@/lib/planner/engine';

const PLAN_ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const HANDOFF_ID = '0b10231b-063c-4d6d-8778-8e18486b6fa4';

const day = (n: number, type: DayPlan['type'], title: string): DayPlan => ({
  day: n, type, zone: 'avachinsky', title, description: '', activityType: type === 'activity' ? 'volcano' : 'hot_spring',
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
});

/** Черновик плана на 10–16 июля 2027: день 2 — термальные источники. */
const DRAFT = {
  id: PLAN_ID,
  revision: 1,
  expires_at: '2099-01-01T00:00:00.000Z',
  params: {
    interests: ['volcano', 'thermal'], arrivalDate: '2027-07-10', departureDate: '2027-07-16',
    adults: 2, children: [], budgetTier: 'comfort',
  },
  days: [
    day(1, 'arrival', 'Прилёт'),
    day(2, 'rest', 'Термальные источники'),
    day(3, 'activity', 'Вулкан Горелый'),
    day(4, 'activity', 'Авачинский'),
    day(5, 'rest', 'Отдых'),
    day(6, 'buffer', 'Резерв на погоду'),
    day(7, 'departure', 'Отъезд'),
  ],
};

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) },
}));

const { recommendMock } = vi.hoisted(() => ({ recommendMock: vi.fn() }));
vi.mock('@/lib/planner', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, recommendTrip: (...a: unknown[]) => recommendMock(...a) };
});

import { POST, runPublicTool } from '@/app/api/mcp/route';
import { executeKuzmichTool } from '@/lib/kuzmich/core';

function dbReply(sql: string): { rows: unknown[] } {
  if (sql.includes('INSERT INTO mcp_handoffs')) return { rows: [{ id: HANDOFF_ID }] };
  if (sql.includes('INSERT INTO trip_plan_drafts')) return { rows: [{ id: PLAN_ID }] };
  if (sql.includes('FROM trip_plan_drafts')) return { rows: [DRAFT] };
  if (sql.includes('UPDATE trip_plan_drafts')) return { rows: [{ revision: 2 }] };
  return { rows: [] };
}

let ipSeq = 0;
async function callTool(name: string, args: Record<string, unknown>) {
  ipSeq += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.22.0.${ipSeq}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const json = await res.json() as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
  return json.result;
}

/** Как показывает ответ клиент, склеивающий элементы content без разделителя. */
const glued = (content: Array<{ text: string }>) => content.map((c) => c.text).join('');

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  query.mockReset();
  query.mockImplementation(async (sql: string) => dbReply(sql));
  recommendMock.mockReset();
  recommendMock.mockResolvedValue({
    days: [day(1, 'arrival', 'Прилёт'), day(2, 'rest', 'Термальные источники'), day(3, 'departure', 'Отъезд')],
    warnings: [],
    priceBreakdown: {
      activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0],
      activityPricing: { tourPriced: 0, estimated: 0, excluded: 0 },
    },
    itinerary: '', catalogueOpen: null,
  });
});

describe('ссылка «Продолжить в Ведаре» не прилипает к адресу страницы плана', () => {
  it('make_trip_plan: после /trip/<id> — перевод строки, а не «Продолжить»', async () => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(2);
    // Данные инструмента — первым элементом и чистыми, ссылка — вторым.
    expect(r.content[0].text).toMatch(new RegExp(`/trip/${PLAN_ID}$`));
    expect(r.content[1].text).toMatch(/^\n+Продолжить в Ведаре: https?:\/\/\S+\/mcp\/h\/[A-Za-z0-9_-]{43}$/);
    // Склейка клиентом: адрес страницы плана кончается на id плана.
    const text = glued(r.content);
    const pageUrl = /https?:\/\/\S*\/trip\/\S+/.exec(text)?.[0];
    expect(pageUrl).toBe(`${pageUrl!.split('/trip/')[0]}/trip/${PLAN_ID}`);
    expect(text).not.toMatch(/\/trip\/\S*Продолжить/);
  });

  it('edit_trip_plan: то же — хвост ссылки не клеится к последней строке', async () => {
    const r = await callTool('edit_trip_plan', { plan_id: PLAN_ID, action: 'flight_delay', delay_days: '1' });
    expect(r.isError).toBeUndefined();
    expect(r.content[1].text).toMatch(/^\n+Продолжить в Ведаре: /);
    expect(glued(r.content)).not.toMatch(/\/trip\/\S*Продолжить/);
  });
});

describe('make_trip_plan: поле children — возрасты, и агент это видит', () => {
  it('MCP: children "2" — один ребёнок двух лет, всего 3 человека, прочтение поля названо', async () => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: '2', budget_tier: 'эконом' });
    const text = r.content[0].text;
    expect(text).toContain('Группа: 2 взр. и 1 ребёнок, всего 3 чел.; возраст ребёнка: 2 года (поле children — возрасты в годах через запятую, не число детей)');
    expect(text).toContain('уровень размещения «эконом»');
  });

  it('MCP: двое детей 6 и 10 — 4 человека, возрасты словами', async () => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: '6, 10' });
    expect(r.content[0].text).toContain('Группа: 2 взр. и 2 ребёнка, всего 4 чел.; возрасты детей: 6 лет, 10 лет (поле children');
  });

  it('A2A — тот же исполнитель и та же строка', async () => {
    const out = await runPublicTool({
      toolName: 'make_trip_plan', rawArguments: { days: '3', interests: 'термальные', when: '2027-07-10', children: '1' },
      ip: '10.22.1.1', userAgent: 'a2a-test', self: false,
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    // Взрослых агент не назвал — это допущение, и оно сказано.
    expect(out.text).toContain('Группа: 2 взр. (число взрослых не названо — допущение) и 1 ребёнок, всего 3 чел.; возраст ребёнка: 1 год (поле children');
  });

  it('чат туриста: прежняя строка группы, без «поле children»', async () => {
    const text = await executeKuzmichTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: '2' });
    expect(text).toContain('Группа: 2 взр., ребёнок 2 лет, средняя подготовка');
    expect(text).not.toMatch(/поле children/);
  });

  // Ревью 22.10: одиночный «0» читался как «детей нет» молча. Агент, следуя
  // описанию «возрасты, не число», так передаёт младенца — и семья с ним
  // получала план без единого возрастного допуска (медведи — с 6 лет).
  // Массив [0] строковое поле приводит к тому же «0».
  it.each([
    ['строкой "0"', '0'],
    ['массивом [0]', [0]],
  ])('MCP: children %s — один ребёнок до года, допуски применяются, прочтение названо', async (_label, children) => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children });
    expect(r.isError).toBeUndefined();
    // Движок получил младенца — от его возраста зависят допуски активностей.
    expect(recommendMock).toHaveBeenCalledTimes(1);
    expect(recommendMock.mock.calls[0][0]).toMatchObject({ adults: 2, children: [0] });
    const text = r.content[0].text;
    expect(text).toContain('Поле children «0» прочитал как одного ребёнка до года: поле — возрасты в годах, а не число детей. Детей нет — не передавай поле.');
    expect(text).toContain('Группа: 2 взр. и 1 ребёнок, всего 3 чел.; возраст ребёнка: до года (поле children');
  });

  it('A2A: children "0" — тот же младенец и та же заметка', async () => {
    const out = await runPublicTool({
      toolName: 'make_trip_plan', rawArguments: { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: '0' },
      ip: '10.22.1.2', userAgent: 'a2a-test', self: false,
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(recommendMock.mock.calls[0][0]).toMatchObject({ children: [0] });
    expect(out.text).toContain('Поле children «0» прочитал как одного ребёнка до года');
  });

  it('чат туриста: «0» по-прежнему «детей нет» — Кузьмичу сказано не передавать поле без детей', async () => {
    const text = await executeKuzmichTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: '0' });
    expect(recommendMock.mock.calls[0][0]).toMatchObject({ children: [] });
    expect(text).toContain('Группа: 2 взр., средняя подготовка');
    expect(text).not.toMatch(/до года|поле children/);
  });

  it('без детей пометки нет и у агента', async () => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '3' });
    expect(r.content[0].text).toContain('Группа: 3 взр., средняя подготовка');
    expect(r.content[0].text).not.toMatch(/поле children/);
  });
});

describe('edit_trip_plan flight_delay: выпавший день назван словами', () => {
  it('задержка на день: номер, дата, занятие и причина — в единственном числе', async () => {
    const r = await callTool('edit_trip_plan', { plan_id: PLAN_ID, action: 'flight_delay', delay_days: '1' });
    const text = r.content[0].text;
    expect(text).toContain('День 2 (11 июля, Термальные источники) выпал: в этот день теперь прилёт.');
    expect(text).not.toMatch(/Выпали дни/);
    expect(text).toContain('прилёт теперь 11 июля (2027-07-11)');
    expect(text).toMatch(/стоят на прежних датах/);
  });

  it('строка ID называет задержку рейса среди правок', async () => {
    const r = await callTool('edit_trip_plan', { plan_id: PLAN_ID, action: 'flight_delay', delay_days: '1' });
    expect(r.content[0].text).toMatch(/Изменить — edit_trip_plan с этим ID: [^.]*учесть задержку рейса \(flight_delay\)\./);
    const made = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10' });
    expect(made.content[0].text).toMatch(/учесть задержку рейса \(flight_delay\)/);
  });
});
