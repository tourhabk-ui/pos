// @vitest-environment node
/**
 * Путь к Gemini: Google напрямую или шлюз Cloudflare AI Gateway (20.11).
 *
 * С прода Google отвечает гео-отказом, и сменой ключа это не лечится.
 * Обход — шлюз `vedar-ai` по адресу GEMINI_BASE_URL. Сторож держит:
 * - адрес принимается только Google или шлюза по точному шаблону: ключ
 *   уходит туда, куда указывает адрес;
 * - ключ идёт заголовком, а не в строке адреса, — у каждого живого пути
 *   (текст, зрение, голос, PDF), проверено вызовом;
 * - через шлюз тела запросов не хранятся (снимки и голос туристов);
 * - проба пути с прода называет исход каждого пути и не печатает адреса.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import {
  geminiEndpoint,
  geminiGatewayBase,
  geminiHeaders,
  geminiUrl,
  GEMINI_DIRECT_BASE,
} from '@/lib/ai/gemini-endpoint';
import { LLM_EGRESS_FILES, LLM_ENDPOINTS, extractLLMHosts } from '@/lib/agents/compliance/provider-registry';

const ACC = '0123456789abcdef0123456789abcdef';
const GW = `https://gateway.ai.cloudflare.com/v1/${ACC}/vedar-ai/google-ai-studio`;
const KEY = 'AIzaTEST-not-a-real-key';

describe('адрес Gemini — только Google или шлюз Cloudflare', () => {
  it('не задан или Google — напрямую', () => {
    expect(geminiEndpoint(undefined)).toEqual({ base: GEMINI_DIRECT_BASE, via: 'direct', rejected: null });
    expect(geminiEndpoint('  ')).toEqual({ base: GEMINI_DIRECT_BASE, via: 'direct', rejected: null });
    expect(geminiEndpoint(`${GEMINI_DIRECT_BASE}/`).via).toBe('direct');
  });

  it('шлюз по шаблону — через шлюз, косая черта в конце не мешает', () => {
    expect(geminiEndpoint(GW)).toEqual({ base: GW, via: 'gateway', rejected: null });
    expect(geminiEndpoint(`${GW}/`).base).toBe(GW);
  });

  it('чужой хост, http, ключ в адресе, не тот провайдер шлюза — не принят, идём к Google', () => {
    for (const bad of [
      'https://evil.example.com/google-ai-studio',
      GW.replace('https://', 'http://'),
      `${GW}?key=x`,
      GW.replace('google-ai-studio', 'anthropic'),
      `https://gateway.ai.cloudflare.com.evil.example/v1/${ACC}/vedar-ai/google-ai-studio`,
      GW.replace(ACC, ACC.slice(0, 31)),
    ]) {
      const e = geminiEndpoint(bad);
      expect(e.via, bad).toBe('direct');
      expect(e.base, bad).toBe(GEMINI_DIRECT_BASE);
      expect(e.rejected, bad).toMatch(/GEMINI_BASE_URL не принят/);
    }
  });

  it('непринятый адрес говорится в лог один раз и без самого значения', async () => {
    vi.stubEnv('GEMINI_BASE_URL', 'https://evil.example.com/secret-path');
    vi.resetModules();
    const fresh = await import('@/lib/ai/gemini-endpoint');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = fresh.geminiUrl('models');
    fresh.geminiUrl('models/x:generateContent');
    const lines = spy.mock.calls.map((c) => c.map(String).join(' '));
    spy.mockRestore();
    vi.unstubAllEnvs();
    expect(first).toBe(`${GEMINI_DIRECT_BASE}/v1beta/models`);
    expect(lines.filter((l) => /\[gemini\].*не принят/.test(l))).toHaveLength(1);
    expect(lines.join('\n')).not.toMatch(/evil\.example|secret-path/);
  });

  it('ключ — заголовком; через шлюз тела не хранятся, напрямую такого заголовка нет', () => {
    const viaGw = geminiHeaders(KEY, geminiEndpoint(GW));
    expect(viaGw['x-goog-api-key']).toBe(KEY);
    expect(viaGw['cf-aig-collect-log-payload']).toBe('false');
    expect(viaGw['Content-Type']).toBe('application/json');
    const direct = geminiHeaders(KEY, geminiEndpoint(undefined), false);
    expect(direct['x-goog-api-key']).toBe(KEY);
    expect(direct).not.toHaveProperty('cf-aig-collect-log-payload');
    expect(direct).not.toHaveProperty('Content-Type');
    expect(geminiUrl('models', geminiEndpoint(GW))).toBe(`${GW}/v1beta/models`);
  });

  it('адрес шлюза для пробы — из проверенных частей', () => {
    expect(geminiGatewayBase(ACC, 'vedar-ai')).toBe(GW);
    expect(geminiGatewayBase('evil.example.com/../', 'vedar-ai')).toBeNull();
    expect(geminiGatewayBase(ACC + '/x', 'vedar-ai')).toBeNull();
    expect(geminiGatewayBase(ACC, 'other')).toBeNull();
    expect(geminiGatewayBase(ACC, '__proto__')).toBeNull();
    expect(geminiGatewayBase(null, 'vedar-ai')).toBeNull();
  });
});

type Call = { url: string; headers: Record<string, string> };

function okGenerate(): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Ответ' }] } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const h = init?.headers;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  return { ...(h as Record<string, string>) };
}

describe('живые пути Gemini идут по адресу из настройки, ключ — заголовком', () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    vi.stubEnv('GEMINI_API_KEY', KEY);
    vi.stubEnv('GEMINI_MODEL', 'gemini-test-flash');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: headersOf(init) });
      return okGenerate();
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const geminiCalls = () => calls.filter((c) => c.url.includes(':generateContent'));

  const PATHS = [
    ['текст (callGeminiDirect)', async () => {
      const { callGeminiDirect } = await import('@/lib/ai/providers');
      await callGeminiDirect([{ role: 'user', content: 'Привет' }]);
    }],
    ['зрение (callVisionDetailed)', async () => {
      const { callVisionDetailed } = await import('@/lib/ai/providers');
      await callVisionDetailed('aGVsbG8=', 'image/jpeg', 'Что на снимке?');
    }],
    ['голос (callGeminiTranscribe)', async () => {
      const { callGeminiTranscribe } = await import('@/lib/ai/providers');
      await callGeminiTranscribe('aGVsbG8=', 'audio/ogg');
    }],
    ['PDF (callGeminiPDF)', async () => {
      const { callGeminiPDF } = await import('@/lib/ai/providers');
      await callGeminiPDF('aGVsbG8=', 'Извлеки данные');
    }],
  ] as const;

  for (const [name, run] of PATHS) {
    it(`${name}: через шлюз — адрес шлюза, ключ в заголовке, тела не хранятся`, async () => {
      vi.stubEnv('GEMINI_BASE_URL', GW);
      await run();
      const g = geminiCalls();
      expect(g.length, 'вызова Gemini не было').toBeGreaterThan(0);
      const c = g[0];
      expect(c.url).toBe(`${GW}/v1beta/models/gemini-test-flash:generateContent`);
      expect(c.url).not.toMatch(/[?&]key=/);
      expect(c.url).not.toContain(KEY);
      expect(c.headers['x-goog-api-key']).toBe(KEY);
      expect(c.headers['cf-aig-collect-log-payload']).toBe('false');
    });

    it(`${name}: без настройки — Google напрямую, ключ в заголовке`, async () => {
      await run();
      const c = geminiCalls()[0];
      expect(c.url).toBe(`${GEMINI_DIRECT_BASE}/v1beta/models/gemini-test-flash:generateContent`);
      expect(c.url).not.toContain(KEY);
      expect(c.headers['x-goog-api-key']).toBe(KEY);
      expect(c.headers).not.toHaveProperty('cf-aig-collect-log-payload');
    });
  }

  it('список моделей — тем же адресом и заголовком', async () => {
    vi.stubEnv('GEMINI_MODEL', '');
    vi.stubEnv('GEMINI_BASE_URL', GW);
    vi.resetModules();
    const { resolveGeminiModel } = await import('@/lib/ai/providers');
    await resolveGeminiModel();
    const list = calls.find((c) => /\/v1beta\/models$/.test(c.url));
    expect(list?.url).toBe(`${GW}/v1beta/models`);
    expect(list?.headers['x-goog-api-key']).toBe(KEY);
  });
});

describe('запрет: ключ Gemini в строке адреса и адрес Google мимо модуля', () => {
  // Обход всего кода, а не одного файла (находка 2 ревью безопасности на
  // #3553): новый файл с самодельным адресом Gemini краснеет здесь.
  const ROOTS = ['lib', 'app', 'scripts', 'components', 'hooks', 'infra'];
  const SOURCE = /\.(?:ts|tsx|js|mjs|cjs)$/;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(process.cwd(), dir))) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const rel = `${dir}/${name}`;
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel);
      else if (SOURCE.test(name)) files.push(rel);
    }
  };
  for (const root of ROOTS) if (existsSync(join(process.cwd(), root))) walk(root);

  /** Где хост Google может стоять строкой: сам модуль адреса и реестр приёмников D2. */
  const HOST_ALLOWED = new Set(['lib/ai/gemini-endpoint.ts', 'lib/agents/compliance/provider-registry.ts']);

  it('обход видит код', () => {
    expect(files).toContain('lib/ai/providers.ts');
    expect(files).toContain('app/api/cron/gemini-path-probe/route.ts');
    expect(files.length).toBeGreaterThan(500);
  });

  it('адрес Google — только в модуле адреса (и в реестре D2)', () => {
    const offenders = files.filter((f) => !HOST_ALLOWED.has(f)
      && /generativelanguage\.googleapis\.com/.test(readFileSync(join(process.cwd(), f), 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('ключ к методу Gemini не дописывается в адрес ни в одном файле', () => {
    const KEY_IN_URL = /(?:generateContent|streamGenerateContent|countTokens|embedContent|models)\?key=/;
    const offenders = files.filter((f) => KEY_IN_URL.test(readFileSync(join(process.cwd(), f), 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('модуль адреса и проба — под надзором D2, их хосты записаны в реестр приёмников', () => {
    for (const f of ['lib/ai/gemini-endpoint.ts', 'app/api/cron/gemini-path-probe/route.ts']) {
      expect(LLM_EGRESS_FILES, f).toContain(f);
    }
    const hosts = extractLLMHosts(readFileSync(join(process.cwd(), 'lib/ai/gemini-endpoint.ts'), 'utf-8'));
    expect(hosts).toEqual(expect.arrayContaining(['generativelanguage.googleapis.com', 'gateway.ai.cloudflare.com']));
    const registered = new Set(LLM_ENDPOINTS.map((e) => e.host));
    expect(hosts.filter((h) => !registered.has(h))).toEqual([]);
  });

  it('модуль адреса ключа в адрес не кладёт: адрес — без ключа, ключ — в заголовке', () => {
    for (const e of [geminiEndpoint(undefined), geminiEndpoint(GW)]) {
      for (const method of ['models', 'models/gemini-x:generateContent']) {
        expect(geminiUrl(method, e)).not.toMatch(/[?&]key=/);
      }
      expect(geminiHeaders(KEY, e)['x-goog-api-key']).toBe(KEY);
    }
  });
});

describe('проба пути с прода', () => {
  const SECRET = 'test-cron-secret';
  let calls: Call[];

  const listOk = () => new Response(JSON.stringify({
    models: [
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-test-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-test-flash', supportedGenerationMethods: ['generateContent'] },
    ],
  }), { status: 200 });
  const geo = () => new Response(
    '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
    { status: 400 },
  );

  beforeEach(() => {
    calls = [];
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('GEMINI_API_KEY', KEY);
    vi.stubEnv('GEMINI_BASE_URL', '');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: headersOf(init) });
      if (url.startsWith(GEMINI_DIRECT_BASE)) return geo();
      if (url.endsWith('/v1beta/models')) return listOk();
      return okGenerate();
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const req = (qs: string, secret = SECRET) => new NextRequest(
    `https://vedarai.ru/api/cron/gemini-path-probe${qs}`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );

  it('без секрета — 401, Google не спрашивается', async () => {
    const { GET } = await import('@/app/api/cron/gemini-path-probe/route');
    const res = await GET(req(`?account=${ACC}&gateway=vedar-ai`, 'wrong'));
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('шлюз открыт, напрямую — гео-отказ: исходы названы, генерация по шлюзу flash-моделью', async () => {
    const { GET } = await import('@/app/api/cron/gemini-path-probe/route');
    const res = await GET(req(`?account=${ACC}&gateway=vedar-ai`));
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.path_exists).toBe(true);
    expect(body.open_paths).toEqual(['gateway']);
    expect(body.results.map((r: { path: string; outcome: string }) => `${r.path}:${r.outcome}`))
      .toEqual(['gateway:open', 'direct:blocked']);
    expect(body.results[0].models).toBe(2);
    expect(body.generate).toMatchObject({ path: 'gateway', model: 'gemini-test-flash', outcome: 'open' });
    expect(body.key).toMatchObject({ present: true, format: 'AIza' });
    expect(body.key.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // В ответе нет ни адресов с id аккаунта, ни ключа.
    expect(text).not.toContain(ACC);
    expect(text).not.toContain(KEY);
    for (const c of calls) {
      expect(c.url).not.toContain(KEY);
      expect(c.headers['x-goog-api-key']).toBe(KEY);
    }
    expect(calls.filter((c) => c.url.startsWith(GW)).every((c) => c.headers['cf-aig-collect-log-payload'] === 'false')).toBe(true);
  });

  // Проба 20.11: первая flash-модель списка — gemini-2.5-flash, которую Google
  // новым ключам не отдаёт (404). Живой код берёт сильнейшую flash-модель;
  // проба обязана проверять ту же.
  it('генерация — той моделью, которой пойдёт живой код, а не первой в списке', async () => {
    const list = {
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: headersOf(init) });
      if (url.startsWith(GEMINI_DIRECT_BASE)) return geo();
      if (url.endsWith('/v1beta/models')) return new Response(JSON.stringify(list), { status: 200 });
      return okGenerate();
    }));
    const { GET } = await import('@/app/api/cron/gemini-path-probe/route');
    const body = await (await GET(req(`?account=${ACC}&gateway=vedar-ai`))).json();
    expect(body.generate).toMatchObject({ path: 'gateway', model: 'gemini-3.8-flash' });
    expect(calls.some((c) => c.url.endsWith('/models/gemini-3.8-flash:generateContent'))).toBe(true);
    // То же правило у живого кода.
    const { pickGeminiModel, geminiModelIds } = await import('@/lib/ai/gemini-endpoint');
    expect(pickGeminiModel(geminiModelIds(list))).toBe('gemini-3.8-flash');

    // Ручная GEMINI_MODEL у живого кода главнее списка — и у пробы тоже.
    vi.stubEnv('GEMINI_MODEL', 'gemini-3.8-pro');
    const forced = await (await GET(req(`?account=${ACC}&gateway=vedar-ai`))).json();
    expect(forced.generate).toMatchObject({ model: 'gemini-3.8-pro' });
  });

  // Проба 2 (20.11) не дождалась генерации за 20 с — столько же ждёт живой
  // код, и «не ответила» не отличало медленный ответ от зависшего. Проба ждёт
  // дольше живого кода и называет свой срок (слово владельца 21.11).
  it('генерация ждёт дольше живого кода и называет срок в ответе', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { GET, GENERATE_PROBE_TIMEOUT_MS } = await import('@/app/api/cron/gemini-path-probe/route');
      const body = await (await GET(req(`?account=${ACC}&gateway=vedar-ai`))).json();
      expect(body.generate.timeout_ms).toBe(GENERATE_PROBE_TIMEOUT_MS);
      // Срок живого кода — 20 с (callGemini, fetchWithRetry timeoutMs).
      expect(GENERATE_PROBE_TIMEOUT_MS).toBeGreaterThan(20_000);
      // Срок, с которым ушёл запрос генерации, — тот, что назван.
      expect(timeouts.mock.calls.map((c) => c[0])).toContain(GENERATE_PROBE_TIMEOUT_MS);
      expect(typeof body.generate.latency_ms).toBe('number');
    } finally {
      timeouts.mockRestore();
    }
  });

  it('адрес из строки запроса пробой не берётся — только аккаунт и имя шлюза', async () => {
    const OTHER = 'fedcba9876543210fedcba9876543210';
    const OTHER_GW = `https://gateway.ai.cloudflare.com/v1/${OTHER}/vedar-ai/google-ai-studio`;
    const { GET } = await import('@/app/api/cron/gemini-path-probe/route');
    await GET(req(`?account=${ACC}&gateway=vedar-ai&base=${encodeURIComponent(OTHER_GW)}&url=${encodeURIComponent(OTHER_GW)}`));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.url.includes(OTHER))).toBe(false);
  });

  it('неверный аккаунт — шлюз не спрашивается, только прямой путь', async () => {
    const { GET } = await import('@/app/api/cron/gemini-path-probe/route');
    const body = await (await GET(req('?account=evil.example.com&gateway=vedar-ai'))).json();
    expect(body.gateway_probed).toBe(false);
    expect(body.results.map((r: { path: string }) => r.path)).toEqual(['direct']);
    expect(body.path_exists).toBe(false);
    expect(calls.every((c) => c.url.startsWith(GEMINI_DIRECT_BASE))).toBe(true);
  });

  it('ключа на проде нет — «не мерялось», а не «закрыто»', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const { GET } = await import('@/app/api/cron/gemini-path-probe/route');
    const body = await (await GET(req(`?account=${ACC}&gateway=vedar-ai`))).json();
    expect(body.path_exists).toBeNull();
    expect(body.note).toMatch(/не задан/);
    expect(calls).toHaveLength(0);
  });

  it('сетевой отказ — «не смог», и ответ «не знаю», а не «нет»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const { GET } = await import('@/app/api/cron/gemini-path-probe/route');
    const body = await (await GET(req(`?account=${ACC}&gateway=vedar-ai`))).json();
    expect(body.results.every((r: { outcome: string }) => r.outcome === 'unreachable')).toBe(true);
    expect(body.path_exists).toBeNull();
  });

  it('исходы по форме ответа Google', async () => {
    const { classifyGemini } = await import('@/app/api/cron/gemini-path-probe/route');
    expect(classifyGemini(200, '{}')).toBe('open');
    expect(classifyGemini(400, '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}')).toBe('blocked');
    expect(classifyGemini(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}')).toBe('open_key_refused');
    expect(classifyGemini(403, '<html>Forbidden</html>')).toBe('blocked');
    expect(classifyGemini(400, '<html>Bad Request</html>')).toBe('http');
    expect(classifyGemini(502, '')).toBe('http');
  });

  it('проба зовётся своим workflow, ждущим свою сборку', () => {
    const WF = readFileSync(join(process.cwd(), '.github/workflows/gemini-path-probe.yml'), 'utf-8');
    expect(WF).toMatch(/\/api\/cron\/gemini-path-probe\?account=/);
    expect(WF).toMatch(/scripts\/wait-for-deploy\.sh/);
    expect(WF).toMatch(/::add-mask::\$ACCOUNT/);
  });
});
