/**
 * Сторож поисковых ног пробы знания — Qwen со встроенным поиском DashScope
 * (13.10, карт-бланш владельца «подключи китайские модели»; 15.10 — аудит,
 * находка CN-probe: поиск принудительный, с источниками, плюс тематический
 * вопрос без домена).
 *
 * Веса и выдача поиска — два разных «знает», а у выдачи три исхода, которые
 * нельзя склеивать (§4.0): «нашла нас», «искала, нас нет», «не искала» — и
 * четвёртый, «спросить не удалось». До 15.10 модель сама решала, искать ли,
 * источников не было, и «не знает» значило любое из трёх.
 *
 * Держится поведением, не текстом: шлюз DashScope подменён на уровне fetch.
 * Проверяется, что ушло в запрос (принудительный поиск и источники по
 * документации Model Studio, прочитанной 15.10) и что вернулось в ответ пробы
 * и в итог владельцу.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { execFileSync } from 'node:child_process';
import { loadWorkflow, stepByName } from '../helpers/workflow-semantics';
import { externalBinary } from '../helpers/external-binary';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));

import { resetFreeQuotaMarks, exhaustedModels } from '@/lib/ai/qwen-free-quota';
import { callQwen, callQwenSearch } from '@/lib/ai/providers';
import {
  KNOWLEDGE_QUESTION, KNOWLEDGE_QUESTION_SEARCH, KNOWLEDGE_QUESTION_TOPIC, GET,
  classifySearchAnswer, sourceDomains, digestText, summarize, type LegResult,
} from '@/app/api/cron/model-knowledge-probe/route';

const CJK = /[一-鿿]/;
const NATIVE = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text-generation/generation';

interface NativeBody {
  model: string;
  input: { messages: Array<{ role: string; content: string }> };
  parameters: {
    result_format?: string;
    max_tokens?: number;
    enable_search?: boolean;
    search_options?: { forced_search?: boolean; enable_source?: boolean };
  };
}
interface CompatBody { model: string; messages: Array<{ role: string; content: string }>; enable_search?: boolean }

/** Ответ шлюза на поисковый запрос. null у источников и счётчика — поля нет вовсе. */
interface SearchReply {
  status?: number;
  raw?: string;
  content?: string;
  sources?: Array<{ url: string; title?: string; site_name?: string }> | null;
  count?: number | null;
}

/**
 * Подменённый шлюз DashScope: каталог из одной модели, совместимый чат без
 * поиска отвечает «不知道», нативный поисковый — по вопросу: `reply(question)`.
 */
function gateway(reply: (question: string) => SearchReply) {
  const compat: CompatBody[] = [];
  const native: Array<{ url: string; body: NativeBody }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen-probe-test' }] }), { status: 200 });
    }
    if (u.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as CompatBody;
      compat.push(body);
      return new Response(JSON.stringify({
        model: body.model, choices: [{ message: { content: '不知道。' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    if (u.endsWith('/text-generation/generation')) {
      const body = JSON.parse(String(init?.body)) as NativeBody;
      native.push({ url: u, body });
      const r = reply(body.input.messages[0].content);
      if (r.status && r.status !== 200) return new Response(r.raw ?? '', { status: r.status });
      return new Response(JSON.stringify({
        output: {
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: r.content ?? '' } }],
          ...(r.sources ? { search_info: { search_results: r.sources.map((s, i) => ({ index: i + 1, icon: '', ...s })) } } : {}),
        },
        usage: {
          input_tokens: 10, output_tokens: 20,
          ...(r.count !== undefined && r.count !== null ? { plugins: { search: { count: r.count } } } : {}),
        },
        request_id: 'req-test',
      }), { status: 200 });
    }
    // Прочее (на раннере — usage-sink расхода на прод) — не чат и не поиск.
    return new Response('{"ok":true}', { status: 200 });
  });
  return { fetchMock, compat, native };
}

function probe(search = ''): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/cron/model-knowledge-probe${search}`, {
    headers: { Authorization: 'Bearer cron-test' },
  }));
}

interface ProbeBody {
  ok: boolean;
  question_with_search: string;
  question_topic: string;
  legs: Array<LegResult>;
  summary: {
    knows: string[]; does_not_know: string[]; did_not_search: string[]; could_not_ask: string[];
    sources: Record<string, string[]>;
  };
  verdict: string;
}

beforeEach(() => {
  resetFreeQuotaMarks();
  vi.stubEnv('DASHSCOPE_API_KEY', 'sk-test');
  vi.stubEnv('QWEN_BASE_URL', '');
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

describe('вопросы поисковых ног', () => {
  it('вопрос о сайте разрешает поиск, называет домен, но ни Камчатки, ни прежнего имени', () => {
    expect(KNOWLEDGE_QUESTION_SEARCH).toMatch(/vedarai\.ru/);
    expect(KNOWLEDGE_QUESTION_SEARCH).toMatch(/联网搜索/);
    expect(KNOWLEDGE_QUESTION_SEARCH).not.toMatch(/不要联网/);
    expect(KNOWLEDGE_QUESTION_SEARCH).not.toMatch(/камчат|kamchat|堪察加/i);
    expect(KNOWLEDGE_QUESTION_SEARCH).not.toMatch(/tour-?hab/i);
    expect(KNOWLEDGE_QUESTION_SEARCH).toMatch(CJK);
    expect(KNOWLEDGE_QUESTION_SEARCH).not.toBe(KNOWLEDGE_QUESTION);
  });

  it('тематический вопрос — о крае, без нашего адреса и имени ни в каком написании', () => {
    expect(KNOWLEDGE_QUESTION_TOPIC).toMatch(/堪察加/);
    expect(KNOWLEDGE_QUESTION_TOPIC).toMatch(/联网搜索/);
    expect(KNOWLEDGE_QUESTION_TOPIC).not.toMatch(/vedar|ведар|维达尔|tour-?hab|kamchatour/i);
    expect(KNOWLEDGE_QUESTION_TOPIC).toMatch(CJK);
  });
});

describe('callQwenSearch: запрос по документации Model Studio', () => {
  it('нативный протокол на хосте QWEN_BASE_URL: принудительный поиск, источники, result_format message', async () => {
    const { fetchMock, native } = gateway(() => ({ content: 'ok', sources: [{ url: 'https://example.cn/a' }], count: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callQwenSearch([{ role: 'user', content: 'q' }], { maxTokens: 50 });
    expect(native).toHaveLength(1);
    expect(native[0].url).toBe(NATIVE);
    expect(native[0].body.model).toBe('qwen-probe-test');
    expect(native[0].body.input.messages).toEqual([{ role: 'user', content: 'q' }]);
    expect(native[0].body.parameters).toMatchObject({
      result_format: 'message',
      max_tokens: 50,
      enable_search: true,
      search_options: { forced_search: true, enable_source: true },
    });
    expect(r).toEqual({
      ok: true, text: 'ok', model: 'qwen-probe-test', search_count: 1,
      sources: [{ url: 'https://example.cn/a', title: null, site_name: null }],
    });
  });

  it('обычный callQwen поиска не включает: совместимый чат без enable_search', async () => {
    const { fetchMock, compat, native } = gateway(() => ({ content: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    await callQwen([{ role: 'user', content: 'q' }], { maxTokens: 50 });
    expect(native).toHaveLength(0);
    expect(compat).toHaveLength(1);
    expect('enable_search' in compat[0]).toBe(false);
  });

  it('403 FreeTierOnly — отказ с причиной, и модель НЕ помечается исчерпанной для живого пути', async () => {
    const { fetchMock } = gateway(() => ({
      status: 403,
      raw: '{"code":"AllocationQuota.FreeTierOnly","message":"The free tier of the model has been exhausted."}',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callQwenSearch([{ role: 'user', content: 'q' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/free_tier_only.*403/);
    expect(exhaustedModels()).toEqual([]);
  });
});

describe('исход поисковой ноги', () => {
  const ans = (text: string, sources: string[] = [], count: number | null = null) =>
    ({ text, search_count: count, sources: sources.map((url) => ({ url })) });

  it('vedarai.ru среди источников — «знает» у обеих ног, даже без имени в ответе', () => {
    for (const mention of ['region', 'brand'] as const) {
      const c = classifySearchAnswer(ans('不清楚具体是什么网站。', ['https://www.vedarai.ru/zh', 'https://baike.baidu.com/x'], 1), mention);
      expect(c.outcome).toBe('knows');
      expect(c.signal).toMatch(/vedarai\.ru/);
      expect(c.search).toEqual({ searched: true, count: 1, sources: 2, domains: ['vedarai.ru', 'baike.baidu.com'] });
    }
  });

  it('тематическая нога: имя в ответе — «знает»; искала без нас — «не знает» с причиной', () => {
    expect(classifySearchAnswer(ans('可以看 维达尔（Vedar）平台。', ['https://ctrip.com/a'], 1), 'brand').outcome).toBe('knows');
    expect(classifySearchAnswer(ans('Ведар показывает места в группах', [], 1), 'brand').outcome).toBe('knows');
    // Только китайское имя, без латиницы и адреса — основное написание для
    // туриста из КНР. В случае выше рядом стоит «Vedar», и потерю 维达尔 из
    // детектора он не ловил (аудит 15.10, W3-china, ревью CN-probe).
    const zhOnly = classifySearchAnswer(ans('维达尔平台可以查到堪察加团队游的余位和火山安全信息。', ['https://ctrip.com/a'], 1), 'brand');
    expect(zhOnly.outcome).toBe('knows');
    expect(zhOnly.signal).toMatch(/упомянула нас/);
    const miss = classifySearchAnswer(ans('推荐携程和马蜂窝。堪察加火山信息可看 KVERT。', ['https://ctrip.com/a', 'https://mafengwo.cn/b'], 1), 'brand');
    expect(miss.outcome).toBe('does_not_know');
    expect(miss.signal).toMatch(/искала, нас нет/);
    // Край назван в самом вопросе: «堪察加» в ответе тематической ноги — не «знает».
    expect(miss.signal).not.toMatch(/Камчатку/);
  });

  it('нет ни источников, ни счётчика — «не искала», а не «не знает»', () => {
    const c = classifySearchAnswer(ans('不知道。'), 'region');
    expect(c.outcome).toBe('did_not_search');
    expect(c.search.searched).toBe(false);
    expect(classifySearchAnswer(ans('推荐携程。'), 'brand').outcome).toBe('did_not_search');
    // Счётчик ноль — тоже не поиск.
    expect(classifySearchAnswer(ans('不知道。', [], 0), 'region').outcome).toBe('did_not_search');
  });

  // Аудит 15.10, находка R-probe: счётчик plugins.search.count — отметка
  // этапа распознавания намерения (документация Model Studio), а при
  // forced_search он почти всегда больше нуля. Ответ без источников при
  // count = 1 прежде уходил «не знает» — «нас нет» без выдачи.
  it('счётчик без источников — «намерение было, выдачи нет», а не «не знает»', () => {
    for (const mention of ['region', 'brand'] as const) {
      const c = classifySearchAnswer(ans('不知道。', [], 1), mention);
      expect(c.outcome, mention).toBe('did_not_search');
      expect(c.signal, mention).toMatch(/намерение поиска было, выдачи шлюз не вернул/);
      expect(c.signal, mention).not.toMatch(/искала, нас нет/);
      expect(c.search, mention).toEqual({ searched: false, count: 1, sources: 0, domains: [] });
    }
  });

  it('назвала нас при одном счётчике без источников — «знает», но откуда, не утверждается', () => {
    const c = classifySearchAnswer(ans('vedarai.ru 是堪察加的旅游平台', [], 1), 'region');
    expect(c.outcome).toBe('knows');
    expect(c.signal).toMatch(/не различить/);
    expect(c.signal).not.toMatch(/из весов, а не из выдачи/);
  });

  it('назвала нас без следа поиска — «знает», и сказано, что это веса, а не выдача', () => {
    const c = classifySearchAnswer(ans('vedarai.ru 是堪察加的旅游平台'), 'region');
    expect(c.outcome).toBe('knows');
    expect(c.signal).toMatch(/из весов/);
  });

  it('домены: без www, без повторов, не-адрес пропущен, но учтён в счёте источников', () => {
    expect(sourceDomains(['https://WWW.Vedarai.ru/zh', 'https://vedarai.ru/', 'не адрес', 'http://m.ctrip.com/x']))
      .toEqual(['vedarai.ru', 'm.ctrip.com']);
    const c = classifySearchAnswer(ans('不知道。', ['не адрес'], null), 'region');
    expect(c.search).toEqual({ searched: true, count: null, sources: 1, domains: [] });
    // Адрес не разобран — наш он или нет, неизвестно: «нас нет» не измерено,
    // а не «не знает» (ревью PR #2518).
    expect(c.outcome).toBe('did_not_search');
    expect(c.signal).toMatch(/адрес не разобран у 1 из 1 источников/);
  });

  it('часть источников не разобрана, среди разобранных нас нет — не «не знает»', () => {
    const c = classifySearchAnswer(ans('推荐携程。', ['https://ctrip.com/a', 'не адрес'], 1), 'brand');
    expect(c.outcome).toBe('did_not_search');
    expect(c.signal).toMatch(/адрес не разобран у 1 из 2 источников/);
    // Все разобраны и нас нет — по-прежнему «не знает».
    expect(classifySearchAnswer(ans('推荐携程。', ['https://ctrip.com/a'], 1), 'brand').outcome).toBe('does_not_know');
    // Разобранный наш — «знает», даже если рядом неразобранный.
    expect(classifySearchAnswer(ans('不知道。', ['https://vedarai.ru/zh', 'не адрес'], 1), 'region').outcome).toBe('knows');
  });
});

describe('проба целиком: две поисковые ноги рядом с весами', () => {
  it('вопрос о сайте нашёл vedarai.ru, тематический искал без нас; домены — в сводке и в итоге', async () => {
    const { fetchMock, native, compat } = gateway((q) => (q === KNOWLEDGE_QUESTION_SEARCH
      ? { content: '这个网站介绍火山旅游。', sources: [{ url: 'https://vedarai.ru/zh', title: 'Ведар' }], count: 1 }
      // Край назван в ответе (он есть и в вопросе), нас — нет: это «не знает», а не «знает».
      : { content: '堪察加团队游推荐携程、马蜂窝。', sources: [{ url: 'https://www.ctrip.com/a' }, { url: 'https://mafengwo.cn/b' }], count: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await probe();
    expect(res.status).toBe(200);
    const body = await res.json() as ProbeBody;
    expect(body.ok).toBe(true);
    expect(body.question_with_search).toBe(KNOWLEDGE_QUESTION_SEARCH);
    expect(body.question_topic).toBe(KNOWLEDGE_QUESTION_TOPIC);
    const byProvider = Object.fromEntries(body.legs.map((l) => [l.provider, l]));
    expect(byProvider['qwen'].outcome).toBe('does_not_know');
    expect(byProvider['qwen'].search).toBeNull();
    expect(byProvider['qwen-search'].outcome).toBe('knows');
    expect(byProvider['qwen-search-topic'].outcome).toBe('does_not_know');
    expect(byProvider['qwen-search-topic'].signal).toMatch(/искала, нас нет/);
    expect(body.summary.knows).toEqual(['qwen-search']);
    expect(body.summary.does_not_know).toEqual(['qwen', 'qwen-search-topic']);
    expect(body.summary.sources).toEqual({ 'qwen-search': ['vedarai.ru'], 'qwen-search-topic': ['ctrip.com', 'mafengwo.cn'] });
    expect(body.summary.could_not_ask).toEqual(expect.arrayContaining(['deepseek', 'kimi', 'glm', 'yandex']));
    // В шлюз: чат без поиска с вопросом без поиска, два поисковых — каждый со своим вопросом.
    expect(compat.map((c) => c.messages[0].content)).toEqual([KNOWLEDGE_QUESTION]);
    expect(native.map((n) => n.body.input.messages[0].content).sort())
      .toEqual([KNOWLEDGE_QUESTION_SEARCH, KNOWLEDGE_QUESTION_TOPIC].sort());
    for (const n of native) expect(n.body.parameters.search_options).toEqual({ forced_search: true, enable_source: true });

    const text = digestText(body.legs, summarize(body.legs));
    expect(text).toContain('Источники поиска:');
    // Счётчик назван тем, что он есть, — отметкой намерения, а не числом поисков (R-probe).
    expect(text).toContain('qwen-search: vedarai.ru; отметка намерения поиска: 1');
    expect(text).toContain('qwen-search-topic: ctrip.com, mafengwo.cn; отметка намерения поиска: 1');
    expect(text).not.toContain('поисков:');
  });

  it('шлюз не искал — «не искали» в сводке, итоге и вердикте, а не «не знают»', async () => {
    const { fetchMock } = gateway(() => ({ content: '不知道。', sources: null, count: null }));
    vi.stubGlobal('fetch', fetchMock);
    const body = await (await probe()).json() as ProbeBody;
    expect(body.summary.did_not_search.sort()).toEqual(['qwen-search', 'qwen-search-topic']);
    expect(body.summary.does_not_know).toEqual(['qwen']);
    expect(body.verdict).toMatch(/не искали или выдачи нет: qwen-search, qwen-search-topic/);
    const text = digestText(body.legs, summarize(body.legs));
    expect(text).toMatch(/Не искали или выдачи нет \(«нас нет» не измерено\)/);
    expect(text).toContain('qwen-search: не искала: в ответе нет ни источников, ни счётчика поиска');
    expect(text).toContain('qwen-search: шлюз источников не вернул');
  });

  // Аудит 15.10, находка R-probe: сторож вызовом пробы целиком, шлюз подменён
  // на уровне fetch. Три ответа шлюза — три исхода у ОБЕИХ поисковых ног, и
  // итог владельцу (Telegram) не ставит «намерение без выдачи» в «Не знают».
  describe('исход поисковых ног решают источники, а не счётчик (R-probe)', () => {
    const SEARCH_LEGS = ['qwen-search', 'qwen-search-topic'];
    const run = async (reply: SearchReply) => {
      const { fetchMock } = gateway(() => reply);
      vi.stubGlobal('fetch', fetchMock);
      const body = await (await probe()).json() as ProbeBody;
      const byProvider = Object.fromEntries(body.legs.map((l) => [l.provider, l]));
      return { body, byProvider, text: digestText(body.legs, summarize(body.legs)) };
    };
    const lineOf = (text: string, head: string) => text.split('\n').find((l) => l.startsWith(head)) ?? '';

    it('счётчик 1, источников нет — «намерение было, выдачи нет»: не в «Не знают» ни в сводке, ни в итоге', async () => {
      const { body, byProvider, text } = await run({ content: '不知道。', sources: [], count: 1 });
      for (const p of SEARCH_LEGS) {
        expect(byProvider[p].outcome, p).toBe('did_not_search');
        expect(byProvider[p].signal, p).toMatch(/намерение поиска было, выдачи шлюз не вернул/);
        expect(byProvider[p].search, p).toEqual({ searched: false, count: 1, sources: 0, domains: [] });
      }
      expect(body.summary.did_not_search.sort()).toEqual(SEARCH_LEGS);
      expect(body.summary.does_not_know).toEqual(['qwen']);
      expect(body.verdict).toMatch(/не знают: qwen; не искали или выдачи нет: qwen-search, qwen-search-topic;/);
      // Что читает владелец: «Не знают» — только нога без поиска, причина у каждой поисковой ноги своя.
      expect(lineOf(text, 'Не знают:')).toBe('Не знают: qwen (qwen-probe-test)');
      expect(lineOf(text, 'Не искали или выдачи нет')).toMatch(/qwen-search \(qwen-probe-test\), qwen-search-topic \(qwen-probe-test\)$/);
      for (const p of SEARCH_LEGS) {
        expect(text).toContain(`${p}: намерение поиска было, выдачи шлюз не вернул: счётчик 1, источников нет`);
        expect(text).toContain(`${p}: шлюз источников не вернул; отметка намерения поиска: 1`);
      }
      expect(text).not.toMatch(/искала, нас нет/);
    });

    it('vedarai.ru среди источников — «знает» у обеих ног', async () => {
      const { body, byProvider } = await run({ content: '不知道。', sources: [{ url: 'https://vedarai.ru/zh' }], count: 1 });
      for (const p of SEARCH_LEGS) {
        expect(byProvider[p].outcome, p).toBe('knows');
        expect(byProvider[p].signal, p).toMatch(/поиск нашёл vedarai\.ru/);
      }
      expect(body.summary.knows.sort()).toEqual(SEARCH_LEGS);
    });

    it('чужой источник и ответ без нас — «искала, нас нет» у обеих ног', async () => {
      const { body, byProvider, text } = await run({
        content: '推荐携程和马蜂窝。', sources: [{ url: 'https://www.ctrip.com/a' }], count: 1,
      });
      for (const p of SEARCH_LEGS) {
        expect(byProvider[p].outcome, p).toBe('does_not_know');
        expect(byProvider[p].signal, p).toBe('искала, нас нет: источников 1, vedarai.ru среди них нет');
      }
      expect(body.summary.does_not_know.sort()).toEqual(['qwen', ...SEARCH_LEGS]);
      expect(body.summary.did_not_search).toEqual([]);
      expect(lineOf(text, 'Не знают:')).toContain('qwen-search (qwen-probe-test), qwen-search-topic (qwen-probe-test)');
      expect(text).not.toMatch(/Не искали/);
    });
  });

  it('403 FreeTierOnly у поиска — «спросить не удалось» с причиной у обеих ног, веса отвечают', async () => {
    const { fetchMock } = gateway(() => ({
      status: 403, raw: '{"code":"AllocationQuota.FreeTierOnly","message":"free tier only"}',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const body = await (await probe()).json() as ProbeBody;
    const byProvider = Object.fromEntries(body.legs.map((l) => [l.provider, l]));
    for (const p of ['qwen-search', 'qwen-search-topic']) {
      expect(byProvider[p].outcome).toBe('could_not_ask');
      expect(byProvider[p].reason).toMatch(/free_tier_only/);
      expect(byProvider[p].search).toBeNull();
    }
    expect(byProvider['qwen'].outcome).toBe('does_not_know');
    expect(body.ok).toBe(true);
  });
});

describe('сводка прогона workflow несёт след поиска по ноге', () => {
  // Аудит 15.10, W3-china (ревью CN-probe): проекция legs в GITHUB_STEP_SUMMARY
  // перечисляла поля вручную и нового поля search не знала. Судится та же
  // проекция jq, взятая из шага workflow, на настоящем ответе роута.
  const JQ = externalBinary('jq');

  it.skipIf(JQ.skip)(JQ.title('проекция legs оставляет search каждой ноги таким, каким его вернул роут'), async () => {
    JQ.require('проекцию сводки workflow пробы знания');
    const step = stepByName(
      loadWorkflow('.github/workflows/model-knowledge-probe.yml').jobs.probe,
      'С ПРОДА — спросить модели, знают ли они vedarai.ru',
    );
    const line = (step.run ?? '').split('\n').find((l) => l.includes('GITHUB_STEP_SUMMARY') && l.includes('legs:'));
    const filter = line ? /jq '([^']+)' \/tmp\/probe\.json/.exec(line)?.[1] : undefined;
    expect(filter, 'в шаге нет проекции legs в сводку').toBeTruthy();

    const { fetchMock } = gateway((q) => (q === KNOWLEDGE_QUESTION_SEARCH
      ? { content: '这个网站介绍火山旅游。', sources: [{ url: 'https://vedarai.ru/zh' }], count: 1 }
      : { content: '推荐携程、马蜂窝。', sources: [{ url: 'https://www.ctrip.com/a' }, { url: 'https://mafengwo.cn/b' }], count: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const raw = await (await probe()).text();
    const body = JSON.parse(raw) as ProbeBody;
    const projected = JSON.parse(execFileSync('jq', [filter as string], { input: raw, encoding: 'utf-8' })) as {
      legs: Array<{ provider: string; search?: unknown }>;
    };

    expect(projected.legs.map((l) => l.provider)).toEqual(body.legs.map((l) => l.provider));
    for (const leg of body.legs) {
      expect(projected.legs.find((l) => l.provider === leg.provider)?.search, leg.provider).toEqual(leg.search);
    }
    // Поисковые ноги несут непустой след — проекция его не обнулила.
    expect(projected.legs.find((l) => l.provider === 'qwen-search-topic')?.search)
      .toEqual({ searched: true, count: 2, sources: 2, domains: ['ctrip.com', 'mafengwo.cn'] });
  });
});
