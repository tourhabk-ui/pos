/**
 * Сторож: бесплатная квота Qwen кончается по моделям, и живой путь обходит
 * исчерпанную модель сам (решение владельца 25.09 «работаем на бесплатной»).
 *
 * Повод. Проба с раннера того дня (qwen-key-probe, прогон 2): из 27 моделей
 * отвечали 23, а 403 `AllocationQuota.FreeTierOnly` давали ровно две — те, что
 * звал наш код: `qwen-plus` (цикл инструментов Кузьмича) и `qwen3.8-max`
 * (сильнейшая по каталогу). Соседи `qwen-plus-latest`, `qwen3.8-max-0902` —
 * с отдельной квотой — отвечали за доли секунды. Код стучался в стену на
 * каждом сообщении, а health будил «Qwen не отвечает».
 *
 * Сторож держит поведение, а не текст: шлюз подменён, и проверяется, куда
 * реально ушли запросы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));

import {
  isFreeQuotaExhausted, markFreeQuotaExhausted, isMarkedExhausted, exhaustedModels,
  freeQuotaSiblings, firstUnexhausted, resetFreeQuotaMarks, FREE_QUOTA_MARK_TTL_MS,
} from '@/lib/ai/qwen-free-quota';

const FREE_TIER_BODY = JSON.stringify({ error: {
  message: 'The free quota has been exhausted. To continue accessing the model on a paid basis, please complete your payment information (or disable the "use free tier only" mode in the management console if already completed).',
  code: 'AllocationQuota.FreeTierOnly',
} });

describe('что считается исчерпанной бесплатной квотой', () => {
  it('403 с кодом FreeTierOnly — да', () => {
    expect(isFreeQuotaExhausted(403, FREE_TIER_BODY)).toBe(true);
  });

  it('прочие отказы — нет: их нельзя прятать под «квоту»', () => {
    expect(isFreeQuotaExhausted(401, FREE_TIER_BODY)).toBe(false);
    expect(isFreeQuotaExhausted(403, '{"error":{"code":"AccessDenied"}}')).toBe(false);
    expect(isFreeQuotaExhausted(null, FREE_TIER_BODY)).toBe(false);
  });
});

describe('кто замещает модель', () => {
  const CATALOG = [
    'qwen-plus', 'qwen-plus-latest', 'qwen-plus-2025-07-28', 'qwen-plus-2025-09-11',
    'qwen-plus-character', 'qwen-plus-character-ja', 'qwen-max', 'qwen3.8-max', 'qwen3.8-max-0902',
    'qwen3x8-max-latest',
  ];

  it('алиас -latest первым, затем снимки от свежих к старым', () => {
    expect(freeQuotaSiblings('qwen-plus', CATALOG)).toEqual([
      'qwen-plus-latest', 'qwen-plus-2025-09-11', 'qwen-plus-2025-07-28',
    ]);
  });

  it('только та же модель: не ролевая, не другой тир', () => {
    const s = freeQuotaSiblings('qwen-plus', CATALOG);
    expect(s).not.toContain('qwen-plus-character');
    expect(s).not.toContain('qwen-max');
  });

  it('короткий снимок вида -0902 — тоже снимок; точка в имени не шаблон', () => {
    expect(freeQuotaSiblings('qwen3.8-max', CATALOG)).toEqual(['qwen3.8-max-0902']);
  });
});

describe('отметка живёт сутки', () => {
  beforeEach(() => resetFreeQuotaMarks());

  it('помеченная пропускается, по истечении — снова пробуется', () => {
    const t0 = 1_000_000;
    markFreeQuotaExhausted('qwen-plus', t0);
    expect(isMarkedExhausted('qwen-plus', t0 + 1)).toBe(true);
    expect(firstUnexhausted(['qwen-plus', 'qwen-plus-latest'], t0 + 1)).toBe('qwen-plus-latest');
    expect(exhaustedModels(t0 + 1)).toEqual(['qwen-plus']);
    expect(isMarkedExhausted('qwen-plus', t0 + FREE_QUOTA_MARK_TTL_MS)).toBe(false);
    expect(exhaustedModels(t0 + FREE_QUOTA_MARK_TTL_MS)).toEqual([]);
  });

  it('квота кончилась у всех — null, а не последняя попавшаяся', () => {
    markFreeQuotaExhausted('a');
    markFreeQuotaExhausted('b');
    expect(firstUnexhausted(['a', 'b'])).toBeNull();
  });
});

/** Подменённый шлюз DashScope: у каких моделей квоты нет, что в каталоге. */
function gateway(exhausted: string[], catalog: string[]) {
  const asked: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/models')) {
      return new Response(JSON.stringify({ data: catalog.map((id) => ({ id })) }), { status: 200 });
    }
    const model = (JSON.parse(String(init?.body)) as { model: string }).model;
    asked.push(model);
    if (exhausted.includes(model)) return new Response(FREE_TIER_BODY, { status: 403 });
    return new Response(JSON.stringify({
      model,
      choices: [{ message: { content: `ответ ${model}` } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 });
  });
  return { fetchMock, asked };
}

describe('живой путь обходит исчерпанную модель', () => {
  beforeEach(() => {
    resetFreeQuotaMarks();
    vi.resetModules();
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-test');
    vi.stubEnv('QWEN_MODEL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('цикл инструментов: qwen-plus без квоты → тот же вызов идёт на qwen-plus-latest', async () => {
    const { fetchMock, asked } = gateway(['qwen-plus'], ['qwen-plus', 'qwen-plus-latest', 'qwen-max']);
    vi.stubGlobal('fetch', fetchMock);
    const { callQwenWithTools } = await import('@/lib/ai/providers');
    const qfq = await import('@/lib/ai/qwen-free-quota');
    qfq.resetFreeQuotaMarks();

    const first = await callQwenWithTools([{ role: 'user', content: 'где медведи?' }], []);
    expect(first?.content).toBe('ответ qwen-plus-latest');
    expect(asked).toEqual(['qwen-plus', 'qwen-plus-latest']);

    // Второе сообщение человека — сразу в живую модель, без стука в стену.
    const second = await callQwenWithTools([{ role: 'user', content: 'а погода?' }], []);
    expect(second?.content).toBe('ответ qwen-plus-latest');
    expect(asked).toEqual(['qwen-plus', 'qwen-plus-latest', 'qwen-plus-latest']);
  });

  it('цикл инструментов: квота кончилась у всех замен — null, ступень уступает следующей', async () => {
    const { fetchMock } = gateway(['qwen-plus', 'qwen-plus-latest'], ['qwen-plus', 'qwen-plus-latest']);
    vi.stubGlobal('fetch', fetchMock);
    const { callQwenWithTools } = await import('@/lib/ai/providers');
    const qfq = await import('@/lib/ai/qwen-free-quota');
    qfq.resetFreeQuotaMarks();

    expect(await callQwenWithTools([{ role: 'user', content: 'ping' }], [])).toBeNull();
    expect(qfq.exhaustedModels()).toEqual(['qwen-plus', 'qwen-plus-latest']);
  });

  it('callQwen: сильнейшая без квоты → следующая по силе', async () => {
    const { fetchMock, asked } = gateway(['qwen3.8-max'], ['qwen3.8-max', 'qwen3.7-max', 'qwen-plus']);
    vi.stubGlobal('fetch', fetchMock);
    const { callQwen } = await import('@/lib/ai/providers');
    const qfq = await import('@/lib/ai/qwen-free-quota');
    qfq.resetFreeQuotaMarks();

    const text = await callQwen([{ role: 'user', content: 'ping' }]);
    expect(asked[0]).toBe('qwen3.8-max');
    expect(asked[1]).not.toBe('qwen3.8-max');
    expect(text).toBe(`ответ ${asked[1]}`);
  });
});

describe('health видит подмену, но не будит ею', () => {
  it('исчерпанные модели при живом Qwen — known, с перечнем', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const health = readFileSync(join(process.cwd(), 'app/api/cron/health/route.ts'), 'utf8');
    const i = health.indexOf('const exhausted = qwenKeyDiag?.exhausted');
    expect(i).toBeGreaterThan(0);
    const block = health.slice(i, health.indexOf('});', i));
    expect(block).toContain('qwenOk && exhausted.length');
    expect(block).toContain("level: 'known'");
  });
});
