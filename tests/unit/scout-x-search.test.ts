// @vitest-environment node
/**
 * Разведчик читает X через xAI (решение владельца 29.09).
 *
 * Держит связку целиком: правило выбора модели (без рассуждений — дешевле и
 * быстрее, проба 29.09), разбор ответа (только настоящие адреса постов),
 * отказ словами вместо пустоты (§4.0), расход по цене провайдера, источник
 * внесён в конвейер дайджеста, в сторож молчания и в реестр егресса (D2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pickXSearchModel, parseXSearchAnswer, buildXSearchPrompt, XAI_USD_PER_TICK,
} from '@/lib/ai/xai-x-search';
import { X_SOURCE, X_HANDLES } from '@/lib/agents/scout-sources';
import { SCOUT_SOURCE_EXPECTATIONS } from '@/lib/services/scout/source-health';
import { LLM_EGRESS_FILES } from '@/lib/agents/compliance/provider-registry';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('выбор модели', () => {
  const CATALOG = [
    'grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning', 'grok-4.20-multi-agent-0309',
    'grok-4.3', 'grok-4.5', 'grok-4.6', 'grok-4.7', 'grok-build-0.1',
    'grok-imagine-image', 'grok-imagine-video',
  ];
  it('без рассуждений — первой: проба 29.09 дала 6 с и $0,07 против 41 с у reasoning', () => {
    expect(pickXSearchModel(CATALOG)).toBe('grok-4.20-0309-non-reasoning');
  });
  it('нет non-reasoning — сильнейшая текстовая grok, не картинки и не видео', () => {
    const m = pickXSearchModel(CATALOG.filter((id) => !/non-reasoning/.test(id)));
    expect(m).toMatch(/^grok-4/);
    expect(m).not.toMatch(/imagine/);
  });
  it('каталог без grok — null, а не выдуманное имя', () => {
    expect(pickXSearchModel(['gpt-x', 'grok-imagine-image'])).toBeNull();
  });
});

describe('разбор ответа', () => {
  it('берёт только записи с адресом поста x.com и текстом, режет дубли', () => {
    const text = 'Вот что нашёл:\n[' +
      '{"handle":"@AnthropicAI","url":"https://x.com/AnthropicAI/status/1","posted_at":"2026-09-28T18:04:06Z","summary_ru":"Вышел Sonnet 5.5"},' +
      '{"handle":"OpenAI","url":"https://x.com/OpenAI/status/1","summary_ru":"дубль по адресу? нет — другой аккаунт"},' +
      '{"handle":"OpenAI","url":"https://x.com/OpenAI/status/1","summary_ru":"а вот это дубль"},' +
      '{"handle":"fake","url":"https://example.com/post","summary_ru":"не пост X"},' +
      '{"handle":"empty","url":"https://x.com/e/status/2","summary_ru":""}' +
      ']';
    const posts = parseXSearchAnswer(text);
    expect(posts.map((p) => p.url)).toEqual(['https://x.com/AnthropicAI/status/1', 'https://x.com/OpenAI/status/1']);
    expect(posts[0].handle).toBe('AnthropicAI');
    expect(posts[0].postedAt).toBe('2026-09-28T18:04:06.000Z');
    expect(posts[1].postedAt).toBeNull();
  });
  it('пустой массив и мусор дают пустой список, а не исключение', () => {
    expect(parseXSearchAnswer('[]')).toEqual([]);
    expect(parseXSearchAnswer('модель написала прозу')).toEqual([]);
    expect(parseXSearchAnswer('[{broken')).toEqual([]);
  });
});

describe('промпт', () => {
  it('в промпте только имена аккаунтов и окно — персональных данных нет по построению', () => {
    const p = buildXSearchPrompt(['OpenAI', 'xai'], 14);
    expect(p).toContain('@OpenAI, @xai');
    expect(p).toContain('14 часов');
    expect(p).toMatch(/пустой массив/);
    expect(p).not.toMatch(/\+7|@gmail|телефон/i);
  });
  it('аккаунты из списка разведчика — короткие имена X без @ и пробелов', () => {
    for (const h of X_HANDLES) expect(h, h).toMatch(/^[A-Za-z0-9_]{1,15}$/);
  });
});

describe('вызов xAI', () => {
  const realFetch = globalThis.fetch;
  const logged: unknown[][] = [];
  beforeEach(() => {
    vi.resetModules();
    logged.length = 0;
    process.env.XAI_API_KEY = 'xai-test';
    process.env.XAI_X_SEARCH_MODEL = 'grok-test';
    vi.doMock('@/lib/ai/providers', () => ({
      logProviderPricedUsage: vi.fn(async (...args: unknown[]) => { logged.push(args); }),
    }));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.XAI_X_SEARCH_MODEL;
  });

  it('кредиты кончились — отказ назван, посты не выдуманы', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      '{"code":"permission-denied","error":"Your team has either used all available credits or reached its monthly spending limit."}',
      { status: 403 },
    )) as unknown as typeof fetch;
    const { searchX } = await import('@/lib/ai/xai-x-search');
    const r = await searchX({ handles: ['OpenAI'], hours: 14 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/кредиты исчерпаны/);
  });

  it('нет ключа — отказ словами, сеть не трогается', async () => {
    delete process.env.XAI_API_KEY;
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const { searchX } = await import('@/lib/ai/xai-x-search');
    const r = await searchX({ handles: ['OpenAI'], hours: 14 });
    expect(r).toEqual({ ok: false, reason: 'XAI_API_KEY не задан' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('успех: инструмент x_search в запросе, посты разобраны, расход — ценой xAI', async () => {
    let sent: { url: string; body: string } | null = null;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      sent = { url, body: String(init?.body ?? '') };
      return new Response(JSON.stringify({
        output: [
          { type: 'custom_tool_call' },
          { type: 'message', content: [{ type: 'output_text', text: '[{"handle":"OpenAI","url":"https://x.com/OpenAI/status/7","posted_at":"2026-09-28T19:15:08Z","summary_ru":"Тизер"}]' }] },
        ],
        usage: {
          input_tokens: 9593, output_tokens: 451, cost_in_usd_ticks: 733475500,
          server_side_tool_usage_details: { x_search_calls: 8 },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const { searchX } = await import('@/lib/ai/xai-x-search');
    const r = await searchX({ handles: ['OpenAI', 'xai'], hours: 14 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model).toBe('grok-test');
    expect(r.posts).toHaveLength(1);
    expect(r.usage?.xSearchCalls).toBe(8);
    expect(r.usage?.costUsd).toBeCloseTo(733475500 * XAI_USD_PER_TICK, 6);
    const body = JSON.parse(sent!.body) as { tools: Array<{ type: string; allowed_x_handles: string[] }> };
    expect(sent!.url).toBe('https://api.x.ai/v1/responses');
    expect(body.tools[0].type).toBe('x_search');
    expect(body.tools[0].allowed_x_handles).toEqual(['OpenAI', 'xai']);
    // Расход ушёл в книги с ценой провайдера, а не по каталогу.
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe('xai:x_search:grok-test');
    expect(logged[0][3]).toBeCloseTo(0.0733, 3);
  });
});

describe('источник встроен в конвейер', () => {
  const DIGEST = read('lib/agents/scout-digest.ts');
  it('дайджест собирает X вместе с RSS и safety-слоем, а не отдельно', () => {
    expect(DIGEST).toMatch(/Promise\.all\(\[\.\.\.RSS_SOURCES\.map\(fetchSource\), fetchXSource\(\), fetchSafetyLayerSource\(\)\]\)/);
    expect(DIGEST).toMatch(/X_SOURCE\.label, SAFETY_LAYER_SOURCE\.label\]/);
    expect(DIGEST).toMatch(/\[X_SOURCE\.label, X_SOURCE\.category\]/);
  });
  it('отказ xAI — статус error с причиной, не пустой список', () => {
    const fn = DIGEST.slice(DIGEST.indexOf('async function fetchXSource'), DIGEST.indexOf('async function fetchXSource') + 1200);
    expect(fn).toMatch(/if \(!r\.ok\) return \{ \.\.\.base, items: \[\], status: 'error', error: r\.reason/);
  });
  it('страницы постов X не тянутся за текстом статьи', () => {
    expect(DIGEST).toMatch(/if \(item\.source === X_SOURCE\.label\) continue;/);
  });
  it('источник сторожится на молчание и стоит в реестре егресса D2', () => {
    expect(SCOUT_SOURCE_EXPECTATIONS.find((e) => e.key === X_SOURCE.key)?.label).toBe(X_SOURCE.label);
    expect(LLM_EGRESS_FILES).toContain('lib/ai/xai-x-search.ts');
    expect(X_SOURCE.kind).toBe('x_search');
  });
});
