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
 * Ревью той же правки: одиночный children «0» у агента читался младенцем.
 *
 * Ловушка MCP 29.10 (безопасность): голое «12» в значении «12 детей»
 * читалось как ребёнок 12 лет и ставило в план восхождения; «двое детей»,
 * «6-10» и «12, малыш» давали «считаю без детей» или теряли младшего — план
 * для взрослых. Теперь неразобранный возраст детей — отказ без плана и без
 * черновика на всех поверхностях (MCP, A2A, чат); голое число — вопрос
 * «возраст или число детей?», в том числе «0» у агента. Массив однозначен:
 * [0] — младенец, [] — детей нет. «0» в чате — по-прежнему «детей нет».
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
  it('MCP: children "2 года" — один ребёнок двух лет, всего 3 человека, прочтение поля названо', async () => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: '2 года', budget_tier: 'эконом' });
    const text = r.content[0].text;
    expect(recommendMock.mock.calls[0][0]).toMatchObject({ adults: 2, children: [2] });
    expect(text).toContain('Группа: 2 взр. и 1 ребёнок, всего 3 чел.; возраст ребёнка: 2 года (поле children — возрасты в годах через запятую, не число детей)');
    expect(text).toContain('уровень размещения «эконом»');
  });

  it('MCP: двое детей 6 и 10 — 4 человека, возрасты словами', async () => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: '6, 10' });
    expect(r.content[0].text).toContain('Группа: 2 взр. и 2 ребёнка, всего 4 чел.; возрасты детей: 6 лет, 10 лет (поле children');
  });

  it('MCP: children массивом JSON [6, 10] — те же двое детей', async () => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: [6, 10] });
    expect(recommendMock.mock.calls[0][0]).toMatchObject({ adults: 2, children: [6, 10] });
    expect(r.content[0].text).toContain('всего 4 чел.');
  });

  it('A2A — тот же исполнитель и та же строка', async () => {
    const out = await runPublicTool({
      toolName: 'make_trip_plan', rawArguments: { days: '3', interests: 'термальные', when: '2027-07-10', children: '1 год' },
      ip: '10.22.1.1', userAgent: 'a2a-test', self: false,
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    // Взрослых агент не назвал — это допущение, и оно сказано.
    expect(out.text).toContain('Группа: 2 взр. (число взрослых не названо — допущение) и 1 ребёнок, всего 3 чел.; возраст ребёнка: 1 год (поле children');
  });

  it('чат туриста: прежняя строка группы, без «поле children»', async () => {
    const text = await executeKuzmichTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: '2 года' });
    expect(text).toContain('Группа: 2 взр., ребёнок 2 лет, средняя подготовка');
    expect(text).not.toMatch(/поле children/);
  });

  // Массив [0] — однозначный список: младенец до года, допуски применяются.
  // Прежде строковое поле приводило его к «0», и [0] был неотличим от голого
  // числа (agesString сохраняет «[0]»).
  it('MCP: children массивом [0] — один ребёнок до года, допуски применяются', async () => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: [0] });
    expect(r.isError).toBeUndefined();
    expect(recommendMock).toHaveBeenCalledTimes(1);
    expect(recommendMock.mock.calls[0][0]).toMatchObject({ adults: 2, children: [0] });
    expect(r.content[0].text).toContain('Группа: 2 взр. и 1 ребёнок, всего 3 чел.; возраст ребёнка: до года (поле children');
  });

  it('MCP: children пустым массивом [] — детей нет, а не отказ схемы', async () => {
    const r = await callTool('make_trip_plan', { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: [] });
    expect(r.isError).toBeUndefined();
    expect(recommendMock.mock.calls[0][0]).toMatchObject({ adults: 2, children: [] });
    expect(r.content[0].text).toContain('Группа: 2 взр., средняя подготовка');
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

describe('make_trip_plan: возраст детей не разобран — плана нет (ловушка 29.10)', () => {
  // Живой ответ 29.10: «вулканы и медведи», июль, children "12" — день 2
  // «Восхождение на вулкан Горелый», день 3 — Авачинский, группа «3 чел.»;
  // «двое детей», «6-10», «12, малыш» — полный взрослый план с теми же
  // восхождениями. Движок не должен получить ни взрослого состава, ни
  // неполного списка.
  it.each([
    ['голое число «12» (возраст или 12 детей?)', '12'],
    ['голое число строкой «2»', '2'],
    ['голое число JSON 12', 12],
    ['«0» у агента (младенец или детей нет?)', '0'],
    ['«двое детей»', 'двое детей'],
    ['диапазон «6-10»', '6-10'],
    ['«12, малыш» — младший не разобран', '12, малыш'],
  ])('MCP: children %s — отказ, движок не вызван, черновика нет', async (_label, children) => {
    const r = await callTool('make_trip_plan', { days: '5', interests: 'вулканы и медведи', when: '2027-07-10', adults: '2', children });
    expect(recommendMock).not.toHaveBeenCalled();
    const text = r.content[0].text;
    expect(text).toMatch(/^План не собран: /);
    expect(text).toContain('спроси у человека возраст каждого');
    expect(text).toMatch(/children: "12 лет" или \[12\]/);
    expect(text).not.toMatch(/ID плана|считаю без детей|День \d/);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO trip_plan_drafts'))).toBe(false);
  });

  it('MCP: «12, малыш» называет того, кого не разобрал', async () => {
    const r = await callTool('make_trip_plan', { days: '5', interests: 'вулканы', when: '2027-07-10', children: '12, малыш' });
    expect(r.content[0].text).toContain('не разобрал «малыш»');
  });

  it('A2A: «двое детей» — тот же отказ', async () => {
    const out = await runPublicTool({
      toolName: 'make_trip_plan', rawArguments: { days: '5', interests: 'вулканы и медведи', when: '2027-07-10', children: 'двое детей' },
      ip: '10.22.1.3', userAgent: 'a2a-test', self: false,
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(recommendMock).not.toHaveBeenCalled();
    expect(out.text).toMatch(/^План не собран: в children «двое детей» не разобрал «двое», «детей»/);
  });

  it('A2A: «0» — вопрос «до года или детей нет?», а не младенец молча', async () => {
    const out = await runPublicTool({
      toolName: 'make_trip_plan', rawArguments: { days: '3', interests: 'термальные', when: '2027-07-10', adults: '2', children: '0' },
      ip: '10.22.1.2', userAgent: 'a2a-test', self: false,
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(recommendMock).not.toHaveBeenCalled();
    expect(out.text).toContain('это ребёнок до года или «детей нет»?');
  });

  it.each([
    ['«12, малыш»', '12, малыш', '«малыш»'],
    ['голое «12»', '12', '«12» — одно число без «лет»'],
  ])('чат туриста: %s — тоже отказ, без имён полей', async (_label, children, named) => {
    const text = await executeKuzmichTool('make_trip_plan', { days: '5', interests: 'вулканы и медведи', when: '2027-07-10', adults: '2', children });
    expect(recommendMock).not.toHaveBeenCalled();
    expect(text).toMatch(/^План не собран: /);
    expect(text).toContain(named);
    expect(text).toContain('Спроси у человека возраст каждого ребёнка');
    expect(text).not.toMatch(/children|ID плана/);
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
