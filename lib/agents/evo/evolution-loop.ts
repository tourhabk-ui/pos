/**
 * Evolution Loop — цикл эволюции проекта.
 *
 * 1. Берёт открытые issues из Growth Scan
 * 2. Ранжирует по severity
 * 3. Для каждого: генерирует фикс через AI
 * 4. Записывает в evo_evolution_log
 * 5. Ждёт фидбек от человека
 *
 * Запускается вручную или через /api/cron/evo
 */

import { pool } from '@/lib/db-pool';
import { callAIDecision } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';
import { deterministicFix } from '@/lib/agents/evo/deterministic-fix';

export interface EvolutionResult {
  processed: number;
  auto_fixes: number;
  suggestions: number;
  errors: number;
  duration_ms: number;
}

/**
 * Главный цикл эволюции.
 */
export async function runEvolutionLoop(): Promise<EvolutionResult> {
  const start = Date.now();
  let processed = 0;
  let autoFixes = 0;
  let suggestions = 0;
  let errors = 0;

  // 1. Берём открытые issues, отсортированные по severity
  const { rows } = await pool.query<{
    id: string;
    category: string;
    severity: string;
    file_path: string | null;
    title: string;
    description: string | null;
    suggestion: string | null;
  }>(`
    SELECT id, category, severity, file_path, title, description, suggestion
    FROM evo_growth_issues
    WHERE status = 'open'
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        ELSE 4
      END,
      created_at ASC
    LIMIT 10
  `);

  if (rows.length === 0) {
    return { processed: 0, auto_fixes: 0, suggestions: 0, errors: 0, duration_ms: Date.now() - start };
  }

  // 2. Получаем learning summary из предыдущих циклов
  const { rows: stateRows } = await pool.query<{ value: string }>(
    `SELECT value FROM evo_agent_state WHERE key = 'learning_summary'`,
  );
  // JSONB already deserialized by pg driver — use directly
  const learningSummary = stateRows[0] ? String(stateRows[0].value) : '';

  for (const issue of rows) {
    processed++;

    try {
      // Предохранитель (решение владельца): авто-применяется ТОЛЬКО
      // детерминированное — индекс-миграция из allowlist'а таблиц/колонок.
      // Модель диффов не пишет: эмитим структурированный payload, а раннер
      // (scripts/evo-apply.js) превращает его в файловую правку и черновой PR.
      const fix = deterministicFix(issue);

      if (fix) {
        await pool.query(
          `INSERT INTO evo_evolution_log (issue_id, action, status, diff_summary)
           VALUES ($1, $2, 'pending', $3)`,
          [issue.id, `auto_fix_${issue.category}`, JSON.stringify(fix)],
        );
        await pool.query(
          `UPDATE evo_growth_issues SET status = 'accepted' WHERE id = $1`,
          [issue.id],
        );
        autoFixes++;
      } else {
        // Не сводится к детерминированной правке — текстовое предложение
        // человеку. Меняем статус на 'suggested', чтобы следующий цикл не
        // обрабатывал повторно.
        const suggestion = await generateSuggestion(issue, learningSummary);
        await pool.query(
          `UPDATE evo_growth_issues SET status = 'suggested', suggestion = $1 WHERE id = $2`,
          [suggestion ?? issue.suggestion, issue.id],
        );
        suggestions++;
      }
    } catch (err) {
      errors++;
      console.error(`[evo] Error processing issue ${issue.id}:`, err);
    }
  }

  // Atomic increment — growth-agent может делать то же самое параллельно.
  // value — JSONB (migration 151): извлекаем скаляр (#>>'{}'), +1, обратно в jsonb.
  await pool.query(
    `UPDATE evo_agent_state SET value = to_jsonb((value#>>'{}')::int + 1), updated_at = NOW() WHERE key = 'cycle_count'`,
  );

  return { processed, auto_fixes: autoFixes, suggestions, errors, duration_ms: Date.now() - start };
}

async function generateSuggestion(issue: {
  category: string; file_path: string | null;
  title: string; description: string | null; suggestion: string | null;
}, learningSummary: string): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты технический ведущий платформы TourHab (туризм Камчатки, Next.js 15 + PostgreSQL, цель — безопасность туристов). Тебе дают проблему из аудита кода. Составь конкретный план её устранения для исполнителя.

Требования к ответу (3-5 коротких пунктов, на русском, без кода):
1. Корневая причина — что именно не так (одна фраза, без "возможно")
2. Конкретные файлы/таблицы/функции (точные пути и имена, не "соответствующие модули")
3. Конкретное действие в каждом файле
4. Главный риск правки и как его проверить (какой сценарий протестировать)

Запрещено: общие советы ("добавить тесты", "улучшить читаемость", "проверить логику") без привязки к коду. Если данных мало для конкретики — прямо укажи, какой файл нужно прочитать, чтобы план стал точным.`,
    },
    {
      role: 'user',
      content: `Проблема: ${issue.title}
Категория: ${issue.category}
${issue.description ? `Описание: ${issue.description}` : ''}
${issue.file_path ? `Файл: ${issue.file_path}` : ''}
${learningSummary ? `\nУроки из прошлых циклов (не повторяй ошибок): ${learningSummary}` : ''}

Дай конкретный план по формату из системного промпта: корневая причина, точные файлы/таблицы, действие в каждом, главный риск и как его проверить. Без общих формулировок.`,
    },
  ];

  try {
    // Сильный решатель: DeepSeek (последний) → Qwen (последний), достижимы из РФ
    const result = await callAIDecision(messages);
    return result?.trim() ?? null;
  } catch {
    return null;
  }
}

