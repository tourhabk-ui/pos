/**
 * Кнопка «AI-новость» в админке давала «Failed to fetch»: тест канала
 * синхронно ждал LLM (callAIQuality: DeepSeek→Qwen→waterfall) + постинг с
 * ретраями и перелезал таймаут прокси. Тест канала проверяет сам канал
 * (пост+фото доходят), а не генерацию текста → режим skipLLM без ожидания LLM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const channel = readFileSync('lib/notifications/telegram-channel.ts', 'utf8');
const route = readFileSync('app/api/admin/channels/test/route.ts', 'utf8');

describe('AI-новость: тест канала без ожидания LLM', () => {
  it('postAINewsToChannel принимает skipLLM', () => {
    expect(channel).toMatch(/skipLLM\?:\s*boolean/);
  });

  it('при skipLLM берётся детерминированный текст (fromFinding), не callAIQuality', () => {
    // Ветка skipLLM должна стоять ПЕРЕД вызовом callAIQuality
    const idxSkip = channel.indexOf('opts.skipLLM');
    const idxQuality = channel.indexOf('callAIQuality([{ role');
    expect(idxSkip).toBeGreaterThan(0);
    expect(idxQuality).toBeGreaterThan(idxSkip);
    expect(channel).toMatch(/if \(opts\.skipLLM\) \{[\s\S]*?postText = fromFinding\(\);/);
  });

  it('тест-эндпоинт зовёт ai_news с skipLLM:true', () => {
    expect(route).toMatch(/postAINewsToChannel\(testFinding,\s*\{\s*skipLLM:\s*true\s*\}\)/);
  });
});
