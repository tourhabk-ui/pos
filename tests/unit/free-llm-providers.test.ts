/**
 * tests/unit/free-llm-providers.test.ts
 *
 * Бесплатные OpenAI-совместимые провайдеры (Groq / Cerebras / Mistral),
 * подключённые аддитивно в waterfall. Проверяем два инварианта:
 *  1. Инертность без ключа — callXxx() возвращает null и НЕ трогает сеть
 *     (гарантия нулевого оверхеда в Tier-1 гонке, пока владелец не поставит ключ).
 *  2. С ключом — POST на правильный OpenAI-совместимый endpoint, парс content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callGroq, callCerebras, callMistral } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

const MSG: ChatMessage[] = [{ role: 'user', content: 'ok' }];

const CASES: Array<{ name: string; fn: (m: ChatMessage[]) => Promise<string | null>; env: string; host: string }> = [
  { name: 'Groq',     fn: callGroq,     env: 'GROQ_API_KEY',     host: 'api.groq.com' },
  { name: 'Cerebras', fn: callCerebras, env: 'CEREBRAS_API_KEY', host: 'api.cerebras.ai' },
  { name: 'Mistral',  fn: callMistral,  env: 'MISTRAL_API_KEY',  host: 'api.mistral.ai' },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Бесплатные LLM-провайдеры — инертность без ключа', () => {
  beforeEach(() => {
    // Гарантируем отсутствие ключей в тест-окружении.
    for (const { env } of CASES) vi.stubEnv(env, '');
  });

  for (const { name, fn } of CASES) {
    it(`${name}: без ключа → null и без сетевого вызова`, async () => {
      const fetchSpy = vi.spyOn(global, 'fetch');
      await expect(fn(MSG)).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});

describe('Бесплатные LLM-провайдеры — happy path с ключом', () => {
  for (const { name, fn, env, host } of CASES) {
    it(`${name}: с ключом → POST на ${host}, парс content`, async () => {
      vi.stubEnv(env, 'test-key-123');
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '  привет  ' } }] }), { status: 200 }),
      );
      const out = await fn(MSG);
      expect(out).toBe('привет'); // trim применён
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = String(fetchSpy.mock.calls[0][0]);
      expect(url).toContain(host);
      expect(url).toContain('/chat/completions');
    });
  }
});
