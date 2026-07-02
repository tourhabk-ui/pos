import { describe, it, expect } from 'vitest';
import { runWithUsageTracking, addUsage, currentAgentId } from '@/lib/ai/usage-context';

describe('usage-context (Roitman §18.7.4 per-agent LLM usage attribution)', () => {
  it('is a no-op outside runWithUsageTracking', () => {
    expect(currentAgentId()).toBeNull();
    expect(() => addUsage(10, 5, 0.001)).not.toThrow();
  });

  it('accumulates usage recorded inside the tracked function', async () => {
    const { result, usage } = await runWithUsageTracking('editor', async () => {
      expect(currentAgentId()).toBe('editor');
      addUsage(100, 50, 0.01);
      addUsage(200, 100, 0.02);
      return 'done';
    });
    expect(result).toBe('done');
    expect(usage).toEqual({
      prompt_tokens: 300,
      completion_tokens: 150,
      llm_calls: 2,
      estimated_cost_usd: 0.03,
    });
  });

  it('accumulates usage recorded in nested async calls, not just the top frame', async () => {
    async function nestedLLMCall() {
      addUsage(10, 5, 0.001);
    }
    const { usage } = await runWithUsageTracking('scout', async () => {
      await nestedLLMCall();
      await nestedLLMCall();
    });
    expect(usage.llm_calls).toBe(2);
    expect(usage.prompt_tokens).toBe(20);
  });

  it('isolates concurrent runWithUsageTracking calls from each other', async () => {
    const [a, b] = await Promise.all([
      runWithUsageTracking('editor', async () => {
        addUsage(100, 0, 0.1);
        await new Promise(r => setTimeout(r, 10));
        addUsage(100, 0, 0.1);
        return null;
      }),
      runWithUsageTracking('scout', async () => {
        addUsage(1, 0, 0.001);
        return null;
      }),
    ]);
    expect(a.usage.prompt_tokens).toBe(200);
    expect(b.usage.prompt_tokens).toBe(1);
  });

  it('does not leak usage recorded after the tracked function returns', async () => {
    await runWithUsageTracking('editor', async () => {
      addUsage(50, 0, 0.01);
    });
    expect(currentAgentId()).toBeNull();
    expect(() => addUsage(999, 999, 999)).not.toThrow();
  });
});
