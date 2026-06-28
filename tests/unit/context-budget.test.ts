import { describe, it, expect } from 'vitest';
import {
  trimHistoryToBudget,
  capMessage,
  estimateTokens,
  HISTORY_KEEP_MIN,
  HISTORY_TOKEN_BUDGET,
  PER_MSG_CHAR_CAP,
} from '@/lib/kuzmich/context-budget';
import type { ChatMessage } from '@/lib/ai/prompts';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

describe('estimateTokens', () => {
  it('approximates ~1 token per 3 chars, safe on empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });
});

describe('capMessage', () => {
  it('leaves short messages untouched', () => {
    const s = 'короткое сообщение';
    expect(capMessage(s)).toBe(s);
  });

  it('truncates oversized messages keeping head and tail', () => {
    const big = 'x'.repeat(PER_MSG_CHAR_CAP + 5000);
    const out = capMessage(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('[сообщение сокращено]');
  });
});

describe('trimHistoryToBudget', () => {
  it('keeps a short history fully', () => {
    const h = [msg('user', 'привет'), msg('assistant', 'здравствуйте')];
    expect(trimHistoryToBudget(h)).toHaveLength(2);
  });

  it('drops oldest messages when over token budget but keeps the most recent', () => {
    // 10 крупных сообщений, каждое ~ весь бюджет → влезет лишь хвост
    const heavy = 'я'.repeat(HISTORY_TOKEN_BUDGET * 3);
    const h: ChatMessage[] = Array.from({ length: 10 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `${heavy}-${i}`),
    );
    const out = trimHistoryToBudget(h);
    expect(out.length).toBeLessThan(h.length);
    // последнее сообщение всегда сохраняется
    expect(out[out.length - 1].content).toContain('-9');
  });

  it('always keeps at least HISTORY_KEEP_MIN recent messages even if each blows the budget', () => {
    const heavy = 'a'.repeat(HISTORY_TOKEN_BUDGET * 3);
    const h: ChatMessage[] = Array.from({ length: 8 }, (_, i) => msg('user', `${heavy}${i}`));
    const out = trimHistoryToBudget(h);
    expect(out.length).toBeGreaterThanOrEqual(HISTORY_KEEP_MIN);
  });

  it('preserves chronological order of the kept tail', () => {
    const h = [
      msg('user', 'a'),
      msg('assistant', 'b'),
      msg('user', 'c'),
      msg('assistant', 'd'),
      msg('user', 'e'),
    ];
    const out = trimHistoryToBudget(h);
    expect(out.map(m => m.content)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
