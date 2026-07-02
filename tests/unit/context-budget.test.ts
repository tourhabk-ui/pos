import { describe, it, expect } from 'vitest';
import {
  trimHistoryToBudget,
  splitHistoryForCompaction,
  capMessage,
  estimateTokens,
  fitTextToTokenBudget,
  HISTORY_KEEP_MIN,
  HISTORY_TOKEN_BUDGET,
  PER_MSG_CHAR_CAP,
} from '@/lib/kuzmich/context-budget';
import type { ChatMessage } from '@/lib/ai/prompts';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

describe('estimateTokens', () => {
  it('approximates ~1 token per 3 chars for latin, safe on empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });

  it('counts Cyrillic heavier than latin (≈1 token / 2 chars)', () => {
    // 6 кириллических символов → ceil(6/2)=3, тяжелее латинских 6 симв (=2)
    expect(estimateTokens('привет')).toBe(3);
    expect(estimateTokens('привет')).toBeGreaterThan(estimateTokens('abcdef'));
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

describe('splitHistoryForCompaction', () => {
  it('reports nothing dropped when everything fits (trimHistoryToBudget delegates to it)', () => {
    const h = [msg('user', 'привет'), msg('assistant', 'здравствуйте')];
    const r = splitHistoryForCompaction(h);
    expect(r.kept).toHaveLength(2);
    expect(r.dropped).toHaveLength(0);
  });

  it('kept + dropped reconstruct the original chronological order', () => {
    const heavy = 'я'.repeat(HISTORY_TOKEN_BUDGET * 3);
    const h: ChatMessage[] = Array.from({ length: 10 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `${heavy}-${i}`),
    );
    const { kept, dropped } = splitHistoryForCompaction(h);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.length + kept.length).toBe(h.length);
    // dropped — самая старая голова, kept — хвост, вместе воспроизводят исходный порядок
    expect([...dropped, ...kept].map(m => m.content)).toEqual(
      h.map(m => capMessage(m.content)),
    );
  });

  it('trimHistoryToBudget(messages) === splitHistoryForCompaction(messages).kept', () => {
    const heavy = 'a'.repeat(HISTORY_TOKEN_BUDGET * 3);
    const h: ChatMessage[] = Array.from({ length: 8 }, (_, i) => msg('user', `${heavy}${i}`));
    expect(trimHistoryToBudget(h)).toEqual(splitHistoryForCompaction(h).kept);
  });
});

describe('fitTextToTokenBudget', () => {
  it('returns text unchanged when within budget', () => {
    const t = 'короткий контекст';
    expect(fitTextToTokenBudget(t, 1000)).toBe(t);
    expect(fitTextToTokenBudget('', 1000)).toBe('');
  });

  it('truncates over-budget text to fit and appends a marker', () => {
    const big = 'я'.repeat(10_000); // ~5000 токенов (кириллица /2)
    const out = fitTextToTokenBudget(big, 500);
    expect(out).toContain('[контекст сокращён');
    expect(estimateTokens(out)).toBeLessThanOrEqual(500 + estimateTokens('\n\n…[контекст сокращён по бюджету токенов]'));
    expect(out.length).toBeLessThan(big.length);
  });

  it('keeps the head (priority blocks first) when truncating', () => {
    const head = 'ВАЖНЫЙ_БЛОК_PLACE ' + 'x'.repeat(200);
    const tail = 'y'.repeat(20_000);
    const out = fitTextToTokenBudget(head + '\n\n' + tail, 100);
    expect(out.startsWith('ВАЖНЫЙ_БЛОК_PLACE')).toBe(true);
  });
});
