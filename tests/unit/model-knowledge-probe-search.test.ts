/**
 * Сторож пятой ноги пробы знания — Qwen со встроенным поиском DashScope
 * (13.10, карт-бланш владельца «подключи китайские модели»).
 *
 * Веса и выдача поиска — два разных «знает». Держится поведением, не
 * текстом: шлюз DashScope подменён на уровне fetch, и проверяется, что
 * ушло в запрос (enable_search) и что вернулось в ответ пробы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));

import { resetFreeQuotaMarks } from '@/lib/ai/qwen-free-quota';
import { callQwen } from '@/lib/ai/providers';
import { KNOWLEDGE_QUESTION, KNOWLEDGE_QUESTION_SEARCH, GET } from '@/app/api/cron/model-knowledge-probe/route';

const CJK = /[一-鿿]/;

interface ChatBody { model: string; messages: Array<{ role: string; content: string }>; enable_search?: boolean }

/** Подменённый шлюз DashScope: каталог из одной модели; ответ зависит от того, включён ли поиск. */
function gateway() {
  const chats: ChatBody[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen-plus' }] }), { status: 200 });
    }
    // Считаются только чаты. На раннере (GITHUB_ACTIONS=true) logLLMUsage шлёт
    // расход на прод через usage-sink тем же fetch — это не чат, в счёт не идёт;
    // CI 13.10 поймал именно это: «ожидали 2, получили 3».
    if (!u.endsWith('/chat/completions')) {
      return new Response('{"ok":true}', { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as ChatBody;
    chats.push(body);
    const content = body.enable_search === true
      ? 'vedarai.ru 是堪察加半岛的旅游平台（搜索结果）'
      : '不知道。';
    return new Response(JSON.stringify({
      model: body.model,
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 });
  });
  return { fetchMock, chats };
}

beforeEach(() => {
  resetFreeQuotaMarks();
  vi.stubEnv('DASHSCOPE_API_KEY', 'sk-test');
  vi.stubEnv('QWEN_MODEL', '');
  vi.stubEnv('CRON_SECRET', 'cron-test');
  // Остальные ноги — без ключей: «спросить нечем», в сеть не ходят.
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('MOONSHOT_API_KEY', '');
  vi.stubEnv('GLM_API_KEY', '');
  vi.stubEnv('YANDEX_API_KEY', '');
  vi.stubEnv('YANDEX_FOLDER_ID', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('вопрос с поиском', () => {
  it('разрешает поиск, называет домен, но ни Камчатки, ни прежнего имени', () => {
    expect(KNOWLEDGE_QUESTION_SEARCH).toMatch(/vedarai\.ru/);
    expect(KNOWLEDGE_QUESTION_SEARCH).toMatch(/联网搜索/);
    expect(KNOWLEDGE_QUESTION_SEARCH).not.toMatch(/不要联网/);
    expect(KNOWLEDGE_QUESTION_SEARCH).not.toMatch(/камчат|kamchat|堪察加/i);
    expect(KNOWLEDGE_QUESTION_SEARCH).not.toMatch(/tour-?hab/i);
    expect(KNOWLEDGE_QUESTION_SEARCH).toMatch(CJK);
    expect(KNOWLEDGE_QUESTION_SEARCH).not.toBe(KNOWLEDGE_QUESTION);
  });
});

describe('callQwen с enableSearch', () => {
  it('кладёт enable_search: true в тело запроса; без опции ключа в теле нет', async () => {
    const { fetchMock, chats } = gateway();
    vi.stubGlobal('fetch', fetchMock);
    await callQwen([{ role: 'user', content: 'q' }], { maxTokens: 50, enableSearch: true });
    await callQwen([{ role: 'user', content: 'q' }], { maxTokens: 50 });
    expect(chats).toHaveLength(2);
    expect(chats[0].enable_search).toBe(true);
    expect('enable_search' in chats[1]).toBe(false);
  });
});

describe('проба: нога qwen-search отдельно от qwen', () => {
  it('две ноги Qwen задают разные вопросы; поиск нашёл Камчатку — «знает», веса — «не знает»', async () => {
    const { fetchMock, chats } = gateway();
    vi.stubGlobal('fetch', fetchMock);
    const req = new NextRequest('http://localhost/api/cron/model-knowledge-probe', {
      headers: { Authorization: 'Bearer cron-test' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      question_with_search: string;
      legs: Array<{ provider: string; outcome: string }>;
      summary: { knows: string[]; does_not_know: string[]; could_not_ask: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.question_with_search).toBe(KNOWLEDGE_QUESTION_SEARCH);
    const byProvider = Object.fromEntries(body.legs.map((l) => [l.provider, l.outcome]));
    expect(byProvider['qwen']).toBe('does_not_know');
    expect(byProvider['qwen-search']).toBe('knows');
    expect(body.summary.knows).toEqual(['qwen-search']);
    expect(body.summary.does_not_know).toEqual(['qwen']);
    expect(body.summary.could_not_ask).toEqual(expect.arrayContaining(['deepseek', 'kimi', 'glm', 'yandex']));
    // В шлюз ушли два чата Qwen: без поиска — вопрос без поиска, с поиском — вопрос с поиском.
    const plain = chats.find((c) => c.enable_search !== true);
    const search = chats.find((c) => c.enable_search === true);
    expect(plain?.messages[0].content).toBe(KNOWLEDGE_QUESTION);
    expect(search?.messages[0].content).toBe(KNOWLEDGE_QUESTION_SEARCH);
  });
});
