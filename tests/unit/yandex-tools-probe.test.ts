// @vitest-environment node
/**
 * Проба YandexGPT с инструментами (06.11, владелец: «Делай»).
 *
 * С прода у цикла инструментов Кузьмича живая одна нога — DeepSeek
 * (ai-debug run 14: Qwen — исчерпанная бесплатная квота, xAI и OpenRouter —
 * гео). YandexGPT с прода отвечает, но зовёт ли он инструмент через адрес,
 * совместимый с OpenAI, документация прямо не говорит. Сторож держит пробу:
 * вызов инструмента — «годится», ответ текстом — «не годится» словами, а не
 * успехом, отказ — с кодом и телом; ключа нет — «нечем спросить»; запрос
 * несёт инструмент, адрес совместимости и каталог.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyYandexToolsReply, probeYandexTools, YANDEX_TOOLS_PROBE_TOOL, YANDEX_TOOLS_PROBE_MODELS,
  probeQwenTools, probeTimewebTools, TIMEWEB_AGENT_BASE,
} from '@/lib/ai/providers';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YANDEX_API_KEY;
  delete process.env.YANDEX_FOLDER_ID;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.QWEN_MODEL;
  delete process.env.TIMEWEB_AI_AGENTS;
});

describe('ответ пробы YandexGPT с инструментами', () => {
  it('позвал инструмент — годится, имя инструмента названо', () => {
    const r = classifyYandexToolsReply(200, {
      choices: [{ message: { content: null, tool_calls: [{ function: { name: 'get_safety_status', arguments: '{}' } }] } }],
    }, 900);
    expect(r).toMatchObject({ provider: 'yandex:tools', status: 'success', answer_preview: 'инструмент позван: get_safety_status' });
  });

  it('ответил текстом без вызова — не успех, а «не годится» словами', () => {
    const r = classifyYandexToolsReply(200, { choices: [{ message: { content: 'Обстановка спокойная.' } }] }, 700);
    expect(r.status).toBe('empty_response');
    expect(r.error).toMatch(/инструмент не позвал/);
  });

  it('отказ провайдера — код и тело, а не «пусто»', () => {
    const r = classifyYandexToolsReply(400, { error: { message: 'tools is not supported' } }, 120);
    expect(r).toMatchObject({ status: 'http_error', http_status: 400 });
    expect(r.error).toMatch(/tools is not supported/);
  });

  it('ни текста, ни вызова — пустой ответ с телом', () => {
    expect(classifyYandexToolsReply(200, { choices: [] }, 50).status).toBe('empty_response');
  });
});

describe('запрос пробы', () => {
  it('без ключа или каталога — «нечем спросить», сеть не трогается', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await probeYandexTools()).status).toBe('no_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('адрес совместимости, модель каталога, инструмент и выбор auto', async () => {
    process.env.YANDEX_API_KEY = 'test-key';
    process.env.YANDEX_FOLDER_ID = 'b1gtestfolder';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: 'get_safety_status' } }] } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeYandexTools();
    expect(r.status).toBe('success');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.api.cloud.yandex.net/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt://b1gtestfolder/yandexgpt/latest');
    expect(body.tools).toEqual([YANDEX_TOOLS_PROBE_TOOL]);
    expect(body.tool_choice).toBe('auto');
    expect(JSON.stringify(body)).not.toMatch(/\+7|@/);
  });

  // ai-debug run 15: yandexgpt/latest ответил заглушкой модерации. Прежде чем
  // назвать YandexGPT негодным — та же проба на модели текстовой ноги.
  it('каждая модель пробы спрашивается своим адресом и подписана своим именем', async () => {
    process.env.YANDEX_API_KEY = 'test-key';
    process.env.YANDEX_FOLDER_ID = 'b1gtestfolder';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Я не могу обсуждать эту тему.' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(YANDEX_TOOLS_PROBE_MODELS).toContain('yandexgpt-5.1/latest');
    for (const model of YANDEX_TOOLS_PROBE_MODELS) {
      const r = await probeYandexTools(model);
      expect(r).toMatchObject({ provider: 'yandex:tools', model, status: 'empty_response' });
    }
    const uris = fetchMock.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).model);
    expect(uris).toEqual(YANDEX_TOOLS_PROBE_MODELS.map((m) => `gpt://b1gtestfolder/${m}`));
  });

  it('тело не JSON (страница шлюза) — доходит до диагностики дословно, а не «ответа нет»', async () => {
    process.env.YANDEX_API_KEY = 'test-key';
    process.env.YANDEX_FOLDER_ID = 'b1gtestfolder';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })));
    const r = await probeYandexTools();
    expect(r).toMatchObject({ status: 'http_error', http_status: 502 });
    expect(r.error).toContain('502 Bad Gateway');
  });
});

/**
 * Замер двух вариантов запасной ноги (владелец 06.11: «замерь 1 и 2»): Qwen
 * платно и шлюз Timeweb. Тот же вопрос и инструмент, то же правило исходов.
 */
describe('замер Qwen: модель ноги и её замена с отдельной квотой', () => {
  it('основная в отказе квоты, замена зовёт инструмент — обе строки, каждая своим именем', async () => {
    process.env.DASHSCOPE_API_KEY = 'test-dashscope';
    process.env.QWEN_MODEL = 'qwen-plus';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen-plus' }, { id: 'qwen-plus-latest' }, { id: 'qwen-max' }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body));
      if (body.model === 'qwen-plus') {
        return new Response(JSON.stringify({ error: { message: 'The free quota has been exhausted.' } }), { status: 403 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ function: { name: 'get_safety_status', arguments: '{}' } }] } }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const rows = await probeQwenTools();
    expect(rows.map((r) => [r.model, r.status])).toEqual([['qwen-plus', 'http_error'], ['qwen-plus-latest', 'success']]);
    expect(rows[0].error).toMatch(/free quota/);
    expect(rows[1].answer_preview).toBe('инструмент позван: get_safety_status');
    const chat = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/chat/completions'));
    expect(JSON.parse(String((chat[1] as unknown as [string, RequestInit])[1].body)).tools).toEqual([YANDEX_TOOLS_PROBE_TOOL]);
  });

  it('без ключа — «нечем спросить», сеть не трогается', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await probeQwenTools())[0]).toMatchObject({ provider: 'qwen:tools', status: 'no_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('замер шлюза Timeweb', () => {
  it('агента нет, шлюз ответил — «агента нет, дорога открыта», а не «работает» и не «недоступно»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Unauthorized"}', { status: 401 })));
    const [r] = await probeTimewebTools();
    expect(r).toMatchObject({ provider: 'timeweb:tools', status: 'no_key', http_status: 401 });
    expect(r.note).toMatch(/агента нет\. Дорога с прода до шлюза открыта: HTTP 401/);
  });

  it('агента нет и шлюз не ответил — так и сказано', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND agent.timeweb.cloud'); }));
    const [r] = await probeTimewebTools();
    expect(r.status).toBe('no_key');
    expect(r.note).toMatch(/шлюз с прода не ответил: .*ENOTFOUND/);
  });

  it('агент заведён — вопрос пробы уходит на адрес агента с его токеном', async () => {
    process.env.TIMEWEB_AI_AGENTS = JSON.stringify({ 'claude-sonnet-5.5': { agentId: 'ag-1', token: 'tw-token' } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ function: { name: 'get_safety_status' } }] } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const [r] = await probeTimewebTools();
    expect(r).toMatchObject({ provider: 'timeweb:tools', model: 'claude-sonnet-5.5', status: 'success' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${TIMEWEB_AGENT_BASE}/ag-1/v1/chat/completions`);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tw-token');
  });
});
