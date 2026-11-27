// @vitest-environment node
/**
 * Проба GigaChat (владелец 27.11: «добавил апи гигачат на таймвеб там на год
 * лимит», «сначала мы его протестим»).
 *
 * Где лежит ключ, не названо: в каталоге шлюза Timeweb или отдельной
 * переменной с ключом Сбера. Проба проверяет оба пути одним прогоном и
 * говорит, что нашла. Сторож держит:
 *  - имена переменных — только имена, значения и токен в ответ не попадают;
 *  - шлюз: каталог спрашивается, модель GigaChat выбирается сильнейшая,
 *    короткий вопрос и вопрос с инструментом уходят на адрес шлюза с ключом;
 *    GigaChat в каталоге нет — так и сказано, лишних вызовов нет;
 *  - Сбер напрямую: токен OAuth (Basic, RqUID, scope), каталог и вопрос с
 *    токеном; отказ сертификата назван кодом причины, а не «fetch failed»;
 *  - вход `?probe=gigachat` отдаёт только строки пробы и общий водопад не зовёт.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GIGACHAT_API_BASE, GIGACHAT_OAUTH_URL, GIGACHAT_PROBE_QUESTION, TIMEWEB_AI_GATEWAY_BASE,
  fetchFailureText, gigachatBasicAuth, gigachatEnvNames, pickGigachatModels, probeGigaChat,
} from '@/lib/ai/providers';

const ENV = ['TIMEWEB_AI_GATEWAY_KEY', 'GIGACHAT_CREDENTIALS', 'GIGACHAT_AUTH_KEY', 'GIGACHAT_SCOPE', 'SBER_TEST_FLAG'];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) delete process.env[k];
});

type Call = { url: string; init: RequestInit };
function stubFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return reply(String(url), init);
  }));
  return calls;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const toolCall = { choices: [{ message: { content: null, tool_calls: [{ function: { name: 'get_safety_status' } }] } }] };

describe('правила пробы', () => {
  it('имена переменных со словом GIGA или SBER — только имена и только непустые', () => {
    expect(gigachatEnvNames({ GIGACHAT_CREDENTIALS: 'секрет', SBER_X: 'y', GIGA_EMPTY: '  ', OTHER: 'z' }))
      .toEqual(['GIGACHAT_CREDENTIALS', 'SBER_X']);
  });

  it('модели GigaChat из каталога — сильнейшая первой, чужие мимо', () => {
    expect(pickGigachatModels(['anthropic/claude-haiku-5-5', 'GigaChat', 'GigaChat-2-Pro', 'sber/GigaChat-2-Max']))
      .toEqual(['sber/GigaChat-2-Max', 'GigaChat-2-Pro', 'GigaChat']);
    expect(pickGigachatModels(['openai/gpt-6-luna'])).toEqual([]);
  });

  it('ключ Сбера: готовый base64 уходит как есть, пара «id:secret» кодируется', () => {
    expect(gigachatBasicAuth(' abc== ')).toBe('abc==');
    expect(gigachatBasicAuth('id:secret')).toBe(Buffer.from('id:secret').toString('base64'));
  });

  it('отказ fetch назван кодом причины — сеть или сертификат различимы', () => {
    const e = new TypeError('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed certificate in certificate chain' } });
    expect(fetchFailureText(e)).toBe('TypeError: fetch failed (SELF_SIGNED_CERT_IN_CHAIN): self-signed certificate in certificate chain');
    expect(fetchFailureText(new Error('boom'))).toBe('Error: boom');
  });
});

describe('проба без ключей', () => {
  it('нечем спросить — три строки «нет ключа» с причиной, сеть не трогается', async () => {
    const calls = stubFetch(() => json({}));
    const rows = await probeGigaChat();
    expect(rows.map((r) => [r.provider, r.status])).toEqual([
      ['gigachat:env', 'no_key'], ['timeweb-gateway:models', 'no_key'], ['gigachat:oauth', 'no_key'],
    ]);
    expect(rows[1].note).toMatch(/TIMEWEB_AI_GATEWAY_KEY не задан/);
    expect(rows[2].note).toMatch(/GIGACHAT_CREDENTIALS/);
    expect(calls).toEqual([]);
  });
});

describe('шлюз Timeweb', () => {
  it('GigaChat в каталоге нет — так и сказано, вопросов модели нет', async () => {
    process.env.TIMEWEB_AI_GATEWAY_KEY = 'tw-gw-test';
    const calls = stubFetch(() => json({ data: [{ id: 'anthropic/claude-haiku-5-5' }, { id: 'openai/gpt-6-luna' }] }));
    const rows = await probeGigaChat();
    const models = rows.find((r) => r.provider === 'timeweb-gateway:models');
    expect(models).toMatchObject({ status: 'empty_response', note: 'в каталоге моделей: 2; GigaChat: нет' });
    expect(calls.map((c) => c.url)).toEqual([`${TIMEWEB_AI_GATEWAY_BASE}/models`]);
    expect(rows.some((r) => r.provider.startsWith('timeweb-gateway:gigachat'))).toBe(false);
  });

  it('GigaChat в каталоге есть — сильнейшая модель, короткий вопрос и вопрос с инструментом на адрес шлюза с ключом', async () => {
    process.env.TIMEWEB_AI_GATEWAY_KEY = 'tw-gw-test';
    const calls = stubFetch((url, init) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'sber/GigaChat-2-Pro' }, { id: 'sber/GigaChat-2-Max' }, { id: 'openai/gpt-6-luna' }] });
      const body = JSON.parse(String(init.body));
      return body.tools ? json(toolCall) : json({ choices: [{ message: { content: 'Петропавловск-Камчатский' } }] });
    });
    const rows = await probeGigaChat();
    const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
    expect(byProvider['timeweb-gateway:models']).toMatchObject({ status: 'success', note: 'в каталоге моделей: 3; GigaChat: sber/GigaChat-2-Max, sber/GigaChat-2-Pro' });
    expect(byProvider['timeweb-gateway:gigachat']).toMatchObject({ status: 'success', model: 'sber/GigaChat-2-Max', answer_preview: 'Петропавловск-Камчатский' });
    expect(byProvider['timeweb-gateway:gigachat-tools']).toMatchObject({ status: 'success', model: 'sber/GigaChat-2-Max' });

    const posts = calls.filter((c) => c.init.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const c of calls) {
      expect(c.url.startsWith(TIMEWEB_AI_GATEWAY_BASE)).toBe(true);
      expect(new Headers(c.init.headers).get('authorization')).toBe('Bearer tw-gw-test');
    }
    const plain = JSON.parse(String(posts[0].init.body));
    expect(plain).toMatchObject({ model: 'sber/GigaChat-2-Max', max_tokens: 30, messages: [{ role: 'user', content: GIGACHAT_PROBE_QUESTION }] });
    expect(plain).not.toHaveProperty('tools');
    expect(JSON.parse(String(posts[1].init.body)).tools).toHaveLength(1);
  });

  it('шлюз отказал каталогом — код и тело отказа, вопросов модели нет', async () => {
    process.env.TIMEWEB_AI_GATEWAY_KEY = 'tw-gw-test';
    const calls = stubFetch(() => new Response('{"error":"unauthorized"}', { status: 401 }));
    const rows = await probeGigaChat();
    expect(rows.find((r) => r.provider === 'timeweb-gateway:models')).toMatchObject({ status: 'http_error', http_status: 401, error: '{"error":"unauthorized"}' });
    expect(calls).toHaveLength(1);
  });
});

describe('Сбер напрямую', () => {
  it('токен OAuth по ключу, затем каталог и вопрос с токеном; ни ключа, ни токена в ответе', async () => {
    process.env.GIGACHAT_CREDENTIALS = 'c2Jlci1rZXk=';
    process.env.SBER_TEST_FLAG = '1';
    const calls = stubFetch((url) => {
      if (url === GIGACHAT_OAUTH_URL) return json({ access_token: 'tok-secret-123', expires_at: 1 });
      if (url.endsWith('/models')) return json({ data: [{ id: 'GigaChat' }, { id: 'GigaChat-2-Max' }] });
      return json({ choices: [{ message: { content: 'Петропавловск-Камчатский' } }] });
    });
    const rows = await probeGigaChat();
    expect(rows.map((r) => [r.provider, r.status])).toEqual([
      ['gigachat:env', 'success'], ['timeweb-gateway:models', 'no_key'],
      ['gigachat:oauth', 'success'], ['gigachat:models', 'success'], ['gigachat:text', 'success'],
    ]);
    expect(rows[0].note).toBe('переменные: GIGACHAT_CREDENTIALS, SBER_TEST_FLAG');
    expect(rows[2].note).toMatch(/ключ из GIGACHAT_CREDENTIALS/);
    expect(rows[4]).toMatchObject({ model: 'GigaChat-2-Max', answer_preview: 'Петропавловск-Камчатский' });

    const [oauth, models, chat] = calls;
    expect(oauth.url).toBe(GIGACHAT_OAUTH_URL);
    const h = new Headers(oauth.init.headers);
    expect(h.get('authorization')).toBe('Basic c2Jlci1rZXk=');
    expect(h.get('rquid')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(oauth.init.body).toBe('scope=GIGACHAT_API_PERS');
    expect(models.url).toBe(`${GIGACHAT_API_BASE}/models`);
    expect(chat.url).toBe(`${GIGACHAT_API_BASE}/chat/completions`);
    for (const c of [models, chat]) expect(new Headers(c.init.headers).get('authorization')).toBe('Bearer tok-secret-123');

    const out = JSON.stringify(rows);
    expect(out).not.toContain('tok-secret-123');
    expect(out).not.toContain('c2Jlci1rZXk=');
  });

  it('scope из GIGACHAT_SCOPE — для ключа юрлица', async () => {
    process.env.GIGACHAT_AUTH_KEY = 'k';
    process.env.GIGACHAT_SCOPE = 'GIGACHAT_API_CORP';
    const calls = stubFetch(() => new Response('{"message":"bad scope"}', { status: 400 }));
    const rows = await probeGigaChat();
    expect(calls[0].init.body).toBe('scope=GIGACHAT_API_CORP');
    expect(rows.find((r) => r.provider === 'gigachat:oauth')).toMatchObject({ status: 'http_error', http_status: 400, model: 'GIGACHAT_API_CORP' });
    expect(calls).toHaveLength(1);
  });

  it('сертификат Сбера не пропущен — код причины в строке, дальше не идём', async () => {
    process.env.GIGACHAT_CREDENTIALS = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', message: 'unable to get local issuer certificate' } });
    }));
    const rows = await probeGigaChat();
    const oauth = rows.find((r) => r.provider === 'gigachat:oauth');
    expect(oauth?.status).toBe('exception');
    expect(oauth?.error).toMatch(/UNABLE_TO_GET_ISSUER_CERT_LOCALLY/);
    expect(rows.some((r) => r.provider === 'gigachat:models')).toBe(false);
  });
});

describe('вход ?probe=gigachat', () => {
  it('отдаёт только строки пробы и общий водопад не зовёт', async () => {
    vi.resetModules();
    const waterfall = vi.fn(async () => []);
    const probe = vi.fn(async () => [{ provider: 'gigachat:env', model: 'env', status: 'no_key', latency_ms: 0 }]);
    vi.doMock('@/lib/ai/providers', () => ({ callAIWaterfallDebug: waterfall, probeGigaChat: probe }));
    vi.doMock('@/lib/auth/cron', () => ({ verifyCronSecret: () => true, diagnoseCronAuth: () => ({}) }));
    const { GET } = await import('@/app/api/ai/debug-waterfall/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('https://vedarai.ru/api/ai/debug-waterfall?probe=gigachat', { headers: { authorization: 'Bearer s' } }));
    const body = await res.json();
    expect(body).toMatchObject({ success: true, probe: 'gigachat', results: [{ provider: 'gigachat:env' }] });
    expect(body).not.toHaveProperty('env_keys');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(waterfall).not.toHaveBeenCalled();
    vi.doUnmock('@/lib/ai/providers');
    vi.doUnmock('@/lib/auth/cron');
  });
});
