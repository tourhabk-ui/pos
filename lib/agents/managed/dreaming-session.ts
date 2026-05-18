/**
 * Stub for the Claude Dreaming API (research preview).
 * Feature-flagged via USE_MANAGED_DREAMING=true.
 * When disabled (default), returns null immediately.
 *
 * Dreaming = long-horizon background research task.
 * Use for: nightly route enrichment, content gap discovery.
 */

import { callManagedAgent } from './client';

export interface DreamingTask {
  topic: string;
  context?: string;
  maxTokens?: number;
}

export interface DreamingResult {
  summary: string;
  raw: string;
}

export async function runDreamingSession(
  task: DreamingTask
): Promise<DreamingResult | null> {
  if (process.env.USE_MANAGED_DREAMING !== 'true') return null;

  const result = await callManagedAgent({
    model: 'claude-opus-4-7',
    system: 'Ты исследовательский агент платформы KamchatourHub. Выдай структурированный анализ по запросу. Отвечай только на русском, без разметки.',
    messages: [
      {
        role: 'user',
        content: task.context
          ? `Контекст:\n${task.context}\n\nЗадача:\n${task.topic}`
          : task.topic,
      },
    ],
    max_tokens: task.maxTokens ?? 1024,
    metadata: { source: 'dreaming-session' },
  });

  if (!result) return null;

  const raw = result.content.map(c => c.text).join('');
  const summary = raw.slice(0, 500);
  return { summary, raw };
}
