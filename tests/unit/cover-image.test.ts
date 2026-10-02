/**
 * Умная обложка поста (DashScope Qwen-Image) + детерминированный фолбэк.
 *
 * Проверяем: фича opt-in (без QWEN_IMAGE_MODEL — старое поведение Pollinations),
 * async-задача DashScope (создать → опросить → URL), тихий откат на Pollinations
 * при любом сбое, приоритет явного промпта, быстрый тест-режим (skipSmartImage),
 * и что хост DashScope виден D2-сканеру и внесён в реестр.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// callAIFastOrNull мокаем: composeCoverPrompt не должен ходить в сеть в тестах.
vi.mock('@/lib/ai/providers', () => ({
  callAIFastOrNull: vi.fn(async () => 'a symbolic glowing brain under a protective dome over a data center'),
}));

import {
  resolveCoverImage,
  dashScopeImageEnabled,
  getDashScopeImageConfig,
} from '@/lib/notifications/cover-image';
import { callAIFastOrNull } from '@/lib/ai/providers';
import {
  LLM_ENDPOINTS,
  LLM_EGRESS_FILES,
  extractLLMHosts,
} from '@/lib/agents/compliance/provider-registry';

const AI_TEXT = '<b>Путин подписал закон о больших ИИ-моделях: суверенные нейросети</b>\n\nТекст новости.';

const ENV_KEYS = ['DASHSCOPE_API_KEY', 'QWEN_IMAGE_MODEL', 'QWEN_IMAGE_POLL_MS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.QWEN_IMAGE_POLL_MS = '5'; // быстрый поллинг в тестах
  vi.restoreAllMocks();
  (callAIFastOrNull as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    'a symbolic glowing brain under a protective dome over a data center',
  );
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.unstubAllGlobals();
});

describe('opt-in: без QWEN_IMAGE_MODEL — прежнее поведение (Pollinations)', () => {
  it('dashScopeImageEnabled false, если модель не задана', () => {
    process.env.DASHSCOPE_API_KEY = 'k';
    delete process.env.QWEN_IMAGE_MODEL;
    expect(dashScopeImageEnabled()).toBe(false);
  });

  it('dashScopeImageEnabled true только при ключе И модели', () => {
    process.env.DASHSCOPE_API_KEY = 'k';
    process.env.QWEN_IMAGE_MODEL = 'wan2.2-t2i-flash';
    expect(dashScopeImageEnabled()).toBe(true);
    expect(getDashScopeImageConfig().model).toBe('wan2.2-t2i-flash');
  });

  it('resolveCoverImage без модели → Pollinations URL, детерминированный промпт', async () => {
    delete process.env.QWEN_IMAGE_MODEL;
    const cover = await resolveCoverImage(AI_TEXT, 'ai', 123);
    expect(cover.source).toBe('pollinations');
    expect(cover.url).toContain('image.pollinations.ai');
    expect(cover.url).toContain('seed=123');
  });

  it('явный imagePrompt имеет приоритет и попадает в URL', async () => {
    delete process.env.QWEN_IMAGE_MODEL;
    const cover = await resolveCoverImage(AI_TEXT, 'ai', 1, { explicitPrompt: 'my custom scene' });
    expect(cover.prompt).toBe('my custom scene');
    expect(decodeURIComponent(cover.url)).toContain('my custom scene');
  });
});

describe('умный путь DashScope (async task)', () => {
  beforeEach(() => {
    process.env.DASHSCOPE_API_KEY = 'k';
    process.env.QWEN_IMAGE_MODEL = 'wan2.2-t2i-flash';
  });

  it('создаёт задачу, опрашивает до SUCCEEDED и возвращает URL картинки', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ output: { task_id: 'T1', task_status: 'PENDING' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ output: { task_status: 'RUNNING' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://oss.example/img.png' }] } }) });
    vi.stubGlobal('fetch', fetchMock);

    const cover = await resolveCoverImage(AI_TEXT, 'ai', 1);
    expect(cover.source).toBe('qwen-image');
    expect(cover.url).toBe('https://oss.example/img.png');
    // Первый вызов — создание задачи на нужном эндпоинте с async-заголовком.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v1/services/aigc/text2image/image-synthesis');
    expect((init as { headers: Record<string, string> }).headers['X-DashScope-Async']).toBe('enable');
  });

  it('задача FAILED → тихий откат на Pollinations', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ output: { task_id: 'T1' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ output: { task_status: 'FAILED' } }) });
    vi.stubGlobal('fetch', fetchMock);

    const cover = await resolveCoverImage(AI_TEXT, 'ai', 7);
    expect(cover.source).toBe('pollinations');
    expect(cover.url).toContain('image.pollinations.ai');
  });

  it('ошибка создания задачи (HTTP 500) → откат на Pollinations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const cover = await resolveCoverImage(AI_TEXT, 'ai', 9);
    expect(cover.source).toBe('pollinations');
  });

  it('skipSmartImage форсирует Pollinations даже при включённой модели', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cover = await resolveCoverImage(AI_TEXT, 'ai', 1, { skipSmartImage: true });
    expect(cover.source).toBe('pollinations');
    expect(fetchMock).not.toHaveBeenCalled(); // сеть не трогали
  });
});

describe('умный путь DashScope: семейство qwen-image — синхронно (01.10)', () => {
  // qwen-image-probe прогон 1: qwen-image-3.0 на text2image — 400
  // InvalidParameter, синхронным multimodal-generation — рисует за 43 с.
  beforeEach(() => {
    process.env.DASHSCOPE_API_KEY = 'k';
    process.env.QWEN_IMAGE_MODEL = 'qwen-image-3.0';
  });

  const ok = (url: string) => ({
    ok: true,
    json: async () => ({ output: { choices: [{ message: { content: [{ image: url }] } }] } }),
  });

  it('qwen-image* идёт в multimodal-generation одним запросом, без задачи', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok('https://oss.example/q3.png'));
    vi.stubGlobal('fetch', fetchMock);
    const cover = await resolveCoverImage(AI_TEXT, 'ai', 1);
    expect(cover.source).toBe('qwen-image');
    expect(cover.url).toBe('https://oss.example/q3.png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v1/services/aigc/multimodal-generation/generation');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['X-DashScope-Async']).toBeUndefined();
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('qwen-image-3.0');
    expect(body.input.messages[0].content[0].text.length).toBeGreaterThan(0);
  });

  it('отказ шлюза — откат на Pollinations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }));
    expect((await resolveCoverImage(AI_TEXT, 'ai', 3)).source).toBe('pollinations');
  });

  it('ответ без картинки — откат на Pollinations, а не пустой URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ output: { choices: [] } }) }));
    expect((await resolveCoverImage(AI_TEXT, 'ai', 4)).source).toBe('pollinations');
  });

  it('разветвление — по имени модели: wan* остаётся на задаче', async () => {
    const { usesMultimodalImageApi } = await import('@/lib/notifications/cover-image');
    expect(usesMultimodalImageApi('qwen-image-3.0')).toBe(true);
    expect(usesMultimodalImageApi('qwen-image')).toBe(true);
    expect(usesMultimodalImageApi('wan2.2-t2i-flash')).toBe(false);
  });
});

describe('D2 / 152-ФЗ: хост DashScope под надзором', () => {
  it('dashscope-intl.aliyuncs.com внесён в реестр как зарубежный', () => {
    const ep = LLM_ENDPOINTS.find((e) => e.host === 'dashscope-intl.aliyuncs.com');
    expect(ep, 'DashScope обязан быть в реестре').toBeDefined();
    expect(ep?.domestic).toBe(false);
  });

  it('cover-image.ts — точка егресса, и сканер видит в ней хост DashScope', () => {
    expect(LLM_EGRESS_FILES).toContain('lib/notifications/cover-image.ts');
    const src = readFileSync(resolve(__dirname, '../../lib/notifications/cover-image.ts'), 'utf8');
    expect(extractLLMHosts(src)).toContain('dashscope-intl.aliyuncs.com');
  });
});
