/**
 * Parallel agent orchestrator — runs independent agent tasks concurrently.
 * Uses Promise.allSettled so one failure never blocks others.
 */

export interface AgentTask<T> {
  name: string;
  fn: () => Promise<T>;
}

export interface AgentResult<T> {
  name: string;
  status: 'fulfilled' | 'rejected';
  value?: T;
  error?: string;
  durationMs: number;
}

export async function runParallel<T>(
  tasks: AgentTask<T>[]
): Promise<AgentResult<T>[]> {
  const started = Date.now();

  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      const t0 = Date.now();
      const value = await task.fn();
      return { name: task.name, value, durationMs: Date.now() - t0 };
    })
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') {
      return {
        name: result.value.name,
        status: 'fulfilled' as const,
        value: result.value.value,
        durationMs: result.value.durationMs,
      };
    }
    return {
      name: tasks[i].name,
      status: 'rejected' as const,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      durationMs: Date.now() - started,
    };
  });
}
