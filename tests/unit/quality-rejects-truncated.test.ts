/**
 * Сторож: путь текста для людей не берёт ответ, оборванный по потолку (26.09).
 *
 * AI-дайджест 25.09 ушёл в канал одним материалом, оборванным на «получает
 * собственную перси»: провайдер ответил 200 с `finish_reason: "length"`, и
 * `callAIQuality` принял непустой обрывок как готовый текст.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));

import { completionTruncated } from '@/lib/ai/providers';

type Reply = { content: string; finish: string };

function gateway(deepseek: Reply, qwen: Reply) {
  const asked: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    const r = u.includes('deepseek') ? deepseek : qwen;
    asked.push(u.includes('deepseek') ? 'deepseek' : 'qwen');
    return new Response(JSON.stringify({
      choices: [{ message: { content: r.content }, finish_reason: r.finish }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }), { status: 200 });
  });
  return { fetchMock, asked };
}

describe('обрыв по потолку распознаётся по полю провайдера', () => {
  it('length — обрыв; stop и отсутствие поля — нет', () => {
    expect(completionTruncated({ choices: [{ finish_reason: 'length' }] })).toBe(true);
    expect(completionTruncated({ choices: [{ finish_reason: 'stop' }] })).toBe(false);
    expect(completionTruncated({ choices: [{}] })).toBe(false);
    expect(completionTruncated(null)).toBe(false);
  });
});

describe('callAIQuality', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ds');
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-qw');
    vi.stubEnv('CONTENT_MODEL', 'deepseek-test');
    vi.stubEnv('CONTENT_QWEN_MODEL', 'qwen-test');
    vi.stubEnv('XAI_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('случай 25.09: DeepSeek оборвал — ответом становится целый текст следующей ступени', async () => {
    const { fetchMock, asked } = gateway(
      { content: 'Каждый пользователь Muse получает собственную перси', finish: 'length' },
      { content: 'Целый пост.', finish: 'stop' },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { callAIQuality } = await import('@/lib/ai/providers');
    const text = await callAIQuality([{ role: 'user', content: 'пост' }]);
    expect(text).toBe('Целый пост.');
    expect(asked.filter((a) => a === 'deepseek').length).toBeGreaterThan(0);
  });

  it('целый ответ DeepSeek берётся сразу, до Qwen не доходит', async () => {
    const { fetchMock, asked } = gateway(
      { content: 'Целый ответ.', finish: 'stop' },
      { content: 'не нужен', finish: 'stop' },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { callAIQuality } = await import('@/lib/ai/providers');
    expect(await callAIQuality([{ role: 'user', content: 'пост' }])).toBe('Целый ответ.');
    expect(asked).not.toContain('qwen');
  });

  it('оборвали обе ступени — обрывок наверх не уходит', async () => {
    const { fetchMock } = gateway(
      { content: 'обрыв один', finish: 'length' },
      { content: 'обрыв два', finish: 'length' },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { callAIQuality } = await import('@/lib/ai/providers');
    const text = await callAIQuality([{ role: 'user', content: 'пост' }]);
    expect(text).not.toBe('обрыв один');
    expect(text).not.toBe('обрыв два');
  });
});
