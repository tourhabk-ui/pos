/**
 * Model-watcher: замечает, когда у провайдера появилась модель СИЛЬНЕЕ той, что
 * решатель эволюции использует сейчас, и заводит intel-находку (→ GitHub Issue).
 * Так смена флагманов видна явно, а не только по логам.
 *
 * Не переключает ничего в бою (решатель и так подхватит новую автоматически —
 * см. model-resolver); задача watcher'а — СООБЩИТЬ человеку. Дедуп по заголовку
 * и по baseline в agent_memory: одна находка на появление модели, не на прогон.
 */

import { pool } from '@/lib/db-pool';
import { agentMemory } from '@/lib/agents/memory/agent-memory';
import { getProviderModelIds } from '@/lib/ai/providers';
import { pickBestModel, scoreModel } from '@/lib/ai/model-resolver';

export interface ModelWatchResult {
  checked: number;
  new_findings: number;
  duration_ms: number;
}

const PROVIDERS = ['deepseek', 'qwen'] as const;
type Provider = typeof PROVIDERS[number];

export interface StoredBest { id: string; score: number }

/**
 * Пора ли заводить находку: есть точка отсчёта (baseline) И новый кандидат
 * СТРОГО сильнее по ранжированию. Чистая функция — под тестом.
 */
export function isStrongerModel(candidateId: string | null, stored: StoredBest | null): boolean {
  if (!candidateId || !stored) return false;      // первый прогон только задаёт baseline
  if (candidateId === stored.id) return false;    // та же модель — не находка
  return scoreModel(candidateId) > stored.score;  // строго сильнее
}

export async function runModelWatcher(): Promise<ModelWatchResult> {
  const start = Date.now();
  let checked = 0;
  let newFindings = 0;

  for (const provider of PROVIDERS) {
    const best = pickBestModel(await getProviderModelIds(provider));
    if (!best) continue;
    checked++;

    const recalled = await agentMemory.recall('evo', `model_watch_${provider}`, 1).catch(() => []);
    const raw = recalled[0]?.value as { id?: string; score?: number } | undefined;
    const stored: StoredBest | null = raw?.id ? { id: raw.id, score: Number(raw.score ?? 0) } : null;

    if (isStrongerModel(best, stored) && stored) {
      const title = `Новее модель ${provider}: ${best}`;
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM evo_growth_issues WHERE status NOT IN ('rejected','ignored') AND title = $1 LIMIT 1`,
        [title],
      );
      if (rows.length === 0) {
        const envVar = provider === 'qwen' ? 'EVO_DECISION_QWEN_MODEL' : 'EVO_DECISION_MODEL';
        await pool.query(
          `INSERT INTO evo_growth_issues (category, severity, title, description, suggestion, status)
           VALUES ('intel', 'medium', $1, $2, $3, 'suggested')`,
          [
            title,
            `У ${provider} доступна модель ${best} — по нашему ранжированию сильнее текущей ${stored.id}. ` +
              'Решатель эволюции подхватит её автоматически (без привязки к id); стоит убедиться в пригодности.',
            `Смоук-тест ${best} на код-ревью/JSON-выводе. Закрепить при желании: ${envVar}=${best}; иначе автоподхват.`,
          ],
        );
        newFindings++;
      }
    }

    // Обновляем baseline (первый прогон только задаёт точку отсчёта, без находки)
    if (!stored || best !== stored.id || scoreModel(best) !== stored.score) {
      await agentMemory.remember({
        agent_id: 'evo',
        memory_type: `model_watch_${provider}`,
        key: 'best',
        value: { id: best, score: scoreModel(best) },
        source: 'model_watcher',
      }).catch(() => { /* некритично */ });
    }
  }

  return { checked, new_findings: newFindings, duration_ms: Date.now() - start };
}
