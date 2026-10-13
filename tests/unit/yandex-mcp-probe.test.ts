// @vitest-environment node
/**
 * Сторож пробы «агент Яндекса ходит в Ведар» (владелец 13.10: «остались
 * российские ИИ») и российской ноги пробы знания.
 *
 * Держится поведением: шлюз Яндекса подменён на уровне fetch, журнал — на
 * уровне пула. Проверяется, что ушло в запрос (инструмент type: mcp с нашим
 * адресом, Api-Key, модель из каталога), как разобран ответ (три исхода) и
 * что приложено из журнала за окно пробы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const journalRows: Array<Record<string, unknown>> = [];
const queries: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return /FROM mcp_tool_calls/.test(sql) ? { rows: journalRows, rowCount: journalRows.length } : { rows: [], rowCount: 0 };
    }),
  },
}));

import { GET, YANDEX_PROBE_QUESTION, MCP_SERVER_LABEL, decideOutcome } from '@/app/api/cron/yandex-mcp-probe/route';
import { GET as knowledgeGet, KNOWLEDGE_QUESTION_RU, KNOWLEDGE_QUESTION } from '@/app/api/cron/model-knowledge-probe/route';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';
import { LLM_ENDPOINTS } from '@/lib/agents/compliance/provider-registry';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Подменённая сеть: ответ шлюза Яндекса задаётся сценарием; всё прочее (журнал расхода на раннере) — ok. */
function network(reply: (url: string, body: Record<string, unknown>) => Response) {
  const captured: Captured[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!/cloud\.yandex\.net/.test(u)) return new Response('{"ok":true}', { status: 200 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.push({ url: u, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body });
    return reply(u, body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { captured, fetchMock };
}

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

function request(secret = 'cron-test') {
  return new NextRequest('http://localhost/api/cron/yandex-mcp-probe', { headers: { Authorization: `Bearer ${secret}` } });
}

beforeEach(() => {
  journalRows.length = 0;
  queries.length = 0;
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.stubEnv('YANDEX_API_KEY', 'key-test');
  vi.stubEnv('YANDEX_AGENT_API_KEY', '');
  vi.stubEnv('YANDEX_FOLDER_ID', 'folder-test');
  vi.stubEnv('YANDEX_AGENT_MODEL', '');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
  // Остальные ноги пробы знания — без ключей: «спросить нечем», в сеть не ходят.
  for (const k of ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'MOONSHOT_API_KEY', 'GLM_API_KEY']) vi.stubEnv(k, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CALLED_TOOLS = {
  output_text: 'Медведей — на Курильском озере; обстановка в крае спокойная.',
  output: [
    { type: 'mcp_list_tools', server_label: 'vedar', tools: [{ name: 'get_tours' }, { name: 'safety_status' }] },
    { type: 'mcp_call', server_label: 'vedar', name: 'safety_status', arguments: '{}', output: '{"ok":true}' },
    { type: 'mcp_call', server_label: 'vedar', name: 'get_tours', arguments: '{"activity_type":"медведи"}', output: '[]' },
    { type: 'message', content: [{ type: 'output_text', text: 'Медведей — на Курильском озере; обстановка в крае спокойная.' }] },
  ],
  usage: { input_tokens: 120, output_tokens: 40 },
};

describe('три исхода пробы', () => {
  it('позвала инструменты: в запросе наш MCP инструментом type: mcp, в ответе имена вызовов и журнал за окно', async () => {
    journalRows.push(
      { client: 'yandex-cloud-mcp-gateway', tool: 'safety_status', ok: true, error_kind: null, at: '13:00:01' },
      { client: 'yandex-cloud-mcp-gateway', tool: 'get_tours', ok: true, error_kind: null, at: '13:00:02' },
    );
    const { captured } = network(() => json(CALLED_TOOLS));
    const before = Date.now();
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('called_tools');
    expect(body.mcp_calls.map((c: { name: string }) => c.name)).toEqual(['safety_status', 'get_tours']);
    expect(body.listed_tools).toBe(2);
    expect(body.output_types).toEqual(['mcp_list_tools', 'mcp_call', 'mcp_call', 'message']);
    expect(body.answer_excerpt).toContain('Курильском');
    expect(body.model).toBe('yandexgpt');
    expect(body.journal_during_probe).toMatchObject({
      calls: 2, tools: ['safety_status', 'get_tours'], failed: null,
      clients: [{ client: 'yandex-cloud-mcp-gateway', calls: 2, region: 'РФ', probe: false }],
    });
    expect(body.verdict).toContain('позвала инструменты Ведара 2 раз');
    expect(body.verdict).toContain('[РФ]');

    // Запрос к шлюзу: наш публичный MCP инструментом, ключ как Api-Key, модель из каталога папки.
    expect(captured).toHaveLength(1);
    const [req] = captured;
    expect(req.url).toBe('https://ai.api.cloud.yandex.net/v1/responses');
    expect(req.headers.Authorization).toBe('Api-Key key-test');
    expect(req.body.model).toBe('gpt://folder-test/yandexgpt');
    expect(req.body.input).toBe(YANDEX_PROBE_QUESTION);
    const tools = req.body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'mcp', server_label: MCP_SERVER_LABEL, server_url: 'https://vedarai.ru/api/mcp' });
    expect((tools[0].metadata as { description: string }).description.length).toBeGreaterThan(20);

    // Журнал читается с окна чуть раньше запроса и только по внешним вызовам.
    const journalQuery = queries.find((q) => /FROM mcp_tool_calls/.test(q.sql));
    expect(journalQuery).toBeDefined();
    expect(journalQuery?.sql).toMatch(/is_self = FALSE/);
    expect(Date.parse(String(journalQuery?.params[0]))).toBeLessThanOrEqual(before);
  });

  it('ответила без инструментов — красный «не подключена»; вызовы чужого клиента в окне названы, не выданы за свои', async () => {
    network(() => json({ output_text: 'Медведей можно увидеть на Курильском озере.', output: [{ type: 'output_text', text: 'Медведей можно увидеть на Курильском озере.' }] }));
    const res = await GET(request());
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.outcome).toBe('answered_without_tools');
    expect(body.mcp_calls).toEqual([]);
    expect(body.output_types).toEqual(['output_text']);
    expect(body.verdict).toContain('не позвав ни одного инструмента');
    expect(body.verdict).toContain('внешних вызовов нет');

    journalRows.push({ client: 'yandex-mcp-hub', tool: 'get_tours', ok: true, error_kind: null, at: '13:00:01' });
    const res2 = await GET(request());
    const body2 = await res2.json();
    expect(body2.outcome).toBe('answered_without_tools');
    expect(body2.verdict).toContain('yandex-mcp-hub');
    expect(body2.verdict).toContain('ru-clients');
  });

  it('провайдер отказал — «спросить не удалось» с кодом и телом, журнал всё равно прочитан', async () => {
    network(() => new Response('{"message":"Permission denied: scope yc.serverless.mcpGateways.invoke"}', { status: 403 }));
    const res = await GET(request());
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.outcome).toBe('could_not_ask');
    expect(body.http_status).toBe(403);
    expect(body.reason).toMatch(/^http_403/);
    expect(body.reason).toContain('mcpGateways.invoke');
    expect(body.verdict).toContain('спросить не удалось');
    expect(body.journal_during_probe).not.toBeNull();
  });

  it('ключа нет — «спросить нечем», в сеть и в журнал не ходит', async () => {
    vi.stubEnv('YANDEX_API_KEY', '');
    const { fetchMock } = network(() => json(CALLED_TOOLS));
    const res = await GET(request());
    const body = await res.json();
    expect(body.outcome).toBe('could_not_ask');
    expect(body.reason).toMatch(/^no_key/);
    expect(body.journal_during_probe).toBeNull();
    expect(fetchMock.mock.calls.filter(([u]) => /cloud\.yandex\.net/.test(String(u)))).toHaveLength(0);
    expect(queries.filter((q) => /FROM mcp_tool_calls/.test(q.sql))).toHaveLength(0);
  });

  it('отдельный ключ агента (YANDEX_AGENT_API_KEY) идёт впереди общего', async () => {
    vi.stubEnv('YANDEX_AGENT_API_KEY', 'agent-key');
    const { captured } = network(() => json(CALLED_TOOLS));
    await GET(request());
    expect(captured[0].headers.Authorization).toBe('Api-Key agent-key');
  });

  it('секрет не сошёлся — 401, запроса к Яндексу нет', async () => {
    const { fetchMock } = network(() => json(CALLED_TOOLS));
    const res = await GET(request('wrong'));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('decideOutcome: отказ → could_not_ask; вызовы → called_tools; только текст → answered_without_tools; пусто → could_not_ask', () => {
    expect(decideOutcome({ error: 'http_403', answer: null, mcp_calls: [] }).outcome).toBe('could_not_ask');
    expect(decideOutcome({ error: null, answer: 'x', mcp_calls: [{ name: 'get_tours', server_label: 'vedar', error: null }] }).outcome).toBe('called_tools');
    expect(decideOutcome({ error: null, answer: 'x', mcp_calls: [] }).outcome).toBe('answered_without_tools');
    expect(decideOutcome({ error: null, answer: null, mcp_calls: [] }).outcome).toBe('could_not_ask');
  });
});

describe('запуск и объявления', () => {
  it('workflow по маркеру ждёт свою сборку и зовёт прод-эндпоинт; возможности объявлены; хост Яндекса в реестре D2 — РФ', () => {
    const wf = read('.github/workflows/yandex-mcp-probe.yml');
    expect(wf).toMatch(/\.github\/triggers\/yandex-mcp-probe\.json/);
    expect(wf).toMatch(/run: bash scripts\/wait-for-deploy\.sh/);
    expect(wf).toMatch(/\/api\/cron\/yandex-mcp-probe/);
    expect(wf).toContain('secrets.CRON_SECRET');
    // Ключ Яндекса живёт на проде, в секреты раннера не приезжает.
    expect(wf).not.toMatch(/secrets\.YANDEX/);
    expect(existsSync(join(ROOT, '.github/triggers/yandex-mcp-probe.json'))).toBe(true);
    const marker = JSON.parse(read('.github/triggers/yandex-mcp-probe.json')) as { run: number; run1_reason: string };
    expect(marker.run).toBeGreaterThanOrEqual(1);
    expect(marker.run1_reason.length).toBeGreaterThan(40);
    expect(CRON_CAPABILITIES['yandex-mcp-probe']).toEqual(expect.arrayContaining(['ai', 'net_out', 'db_read']));
    expect(MANUAL_ENDPOINTS['yandex-mcp-probe']).toBeUndefined();
    const host = LLM_ENDPOINTS.find((e) => e.host === 'ai.api.cloud.yandex.net');
    expect(host).toMatchObject({ jurisdiction: 'Russia', domestic: true });
  });
});

describe('российская нога пробы знания', () => {
  it('вопрос по-русски: домен и имя есть, Камчатки и прежнего имени нет', () => {
    expect(KNOWLEDGE_QUESTION_RU).toMatch(/vedarai\.ru/);
    expect(KNOWLEDGE_QUESTION_RU).toMatch(/[а-яё]/i);
    expect(KNOWLEDGE_QUESTION_RU).not.toMatch(/камчат|kamchat|堪察加/i);
    expect(KNOWLEDGE_QUESTION_RU).not.toMatch(/tour-?hab|тур-?хаб/i);
    expect(KNOWLEDGE_QUESTION_RU).not.toBe(KNOWLEDGE_QUESTION);
  });

  it('YandexGPT спрашивается на своём языке; «не знаю» — не знает, Камчатка в ответе — знает', async () => {
    const asked: string[] = [];
    let answer = 'Не знаю.';
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!/foundationModels\/v1\/completion/.test(u)) return new Response('{"ok":true}', { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ text: string }> };
      asked.push(body.messages[0].text);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Api-Key key-test');
      return new Response(JSON.stringify({ result: { alternatives: [{ message: { text: answer } }] } }), { status: 200 });
    }));
    const req = () => new NextRequest('http://localhost/api/cron/model-knowledge-probe', { headers: { Authorization: 'Bearer cron-test' } });

    let body = await (await knowledgeGet(req())).json();
    expect(body.question_ru).toBe(KNOWLEDGE_QUESTION_RU);
    expect(asked).toEqual([KNOWLEDGE_QUESTION_RU]);
    let leg = body.legs.find((l: { provider: string }) => l.provider === 'yandex');
    expect(leg.outcome).toBe('does_not_know');
    expect(body.summary.does_not_know).toEqual(['yandex']);

    answer = 'Ведар — туристическая платформа Камчатки: туры, безопасность, маршруты.';
    body = await (await knowledgeGet(req())).json();
    leg = body.legs.find((l: { provider: string }) => l.provider === 'yandex');
    expect(leg.outcome).toBe('knows');
    expect(leg.old_brand).toBe(false);
    expect(body.summary.knows).toEqual(['yandex']);
  });

  it('ключа нет — «спросить не удалось» с причиной из следа, а не пустота', async () => {
    vi.stubEnv('YANDEX_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    const body = await (await knowledgeGet(new NextRequest('http://localhost/api/cron/model-knowledge-probe', { headers: { Authorization: 'Bearer cron-test' } }))).json();
    const leg = body.legs.find((l: { provider: string }) => l.provider === 'yandex');
    expect(leg.outcome).toBe('could_not_ask');
    expect(leg.reason).toContain('YANDEX_API_KEY');
  });
});
