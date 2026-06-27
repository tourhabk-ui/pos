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
import { callAIWithModelDirect } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

export interface EvolutionResult {
  processed: number;
  auto_fixes: number;
  suggestions: number;
  errors: number;
  duration_ms: number;
}

// Действия которые AI может выполнять автоматически (без одобрения)
const SAFE_AUTO_FIXES = new Set([
  'dead_code',     // удаление мёртвых файлов
  'add_indexes',   // добавление индексов БД
]);

// Файлы которые AI НЕ трогает без одобрения
const PROTECTED_PATHS = [
  'lib/auth/',
  'lib/payments/',
  'app/api/webhook/',
  'app/api/payments/',
  '.env',
];

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
      const canAutoFix = SAFE_AUTO_FIXES.has(issue.category)
        && !isProtectedPath(issue.file_path);

      if (canAutoFix) {
        // Автоматический фикс — генерируем diff
        const diff = await generateFix(issue, learningSummary);
        if (diff) {
          await pool.query(
            `INSERT INTO evo_evolution_log (issue_id, action, status, diff_summary)
             VALUES ($1, $2, 'pending', $3)`,
            [issue.id, `auto_fix_${issue.category}`, diff.slice(0, 4000)],
          );
          await pool.query(
            `UPDATE evo_growth_issues SET status = 'accepted' WHERE id = $1`,
            [issue.id],
          );
          autoFixes++;
        }
      } else {
        // Только предложение — ждёт фидбека человека.
        // Меняем статус на 'suggested', чтобы следующий цикл не обрабатывал повторно.
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

  // Atomic increment — growth-agent может делать то же самое параллельно
  await pool.query(
    `UPDATE evo_agent_state SET value = (value::int + 1)::text, updated_at = NOW() WHERE key = 'cycle_count'`,
  );

  return { processed, auto_fixes: autoFixes, suggestions, errors, duration_ms: Date.now() - start };
}

function isProtectedPath(filePath: string | null): boolean {
  if (!filePath) return true; // без file_path — не трогаем
  return PROTECTED_PATHS.some(p => filePath.includes(p));
}

async function generateFix(issue: {
  category: string; file_path: string | null;
  title: string; description: string | null; suggestion: string | null;
}, learningSummary: string): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты инженер платформы TourHab (Next.js 15, TypeScript strict, PostgreSQL без Prisma). Генерируешь минимальный безопасный unified diff для авто-применения БЕЗ ручного ревью — правка должна быть точечной и ничего не ломать вокруг.

Обязательные правила (нарушение = отказ применять):
- SQL только параметризованный ($1,$2), никогда конкатенация
- import { pool } from '@/lib/db-pool' (named), никогда default import
- Никакого отладочного console-вывода, эмодзи, секретов в коде
- Миграции БД — только отдельным файлом migrations/NNN_name.sql, идемпотентно (IF NOT EXISTS); индексы на больших таблицах через CREATE INDEX CONCURRENTLY (вне транзакции)
- НЕ менять auth, payments, webhook, схему существующих таблиц
- Изменяй минимум строк

Верни ТОЛЬКО unified diff, без объяснений и markdown. Контекстные строки (@@) должны точно соответствовать реальному коду — если не уверен в точном содержимом файла, верни единственную строку:
NEED_CONTEXT: <что именно нужно увидеть>

Формат:
--- a/path/to/file
+++ b/path/to/file
@@ -old,start +new,start @@
 контекст
-удалить
+добавить

Если файл — подтверждённый мёртвый модуль и нужно удалить целиком:
DELETE FILE: path/to/file`,
    },
    {
      role: 'user',
      content: `Категория: ${issue.category}
Проблема: ${issue.title}
${issue.description ? `Описание: ${issue.description}` : ''}
${issue.suggestion ? `Предложенное направление: ${issue.suggestion}` : ''}
${issue.file_path ? `Целевой файл: ${issue.file_path}` : ''}
${learningSummary ? `\nУроки из прошлых циклов (не повторяй ошибок): ${learningSummary}` : ''}

Если категория add_indexes — верни diff нового файла-миграции migrations/NNN_name.sql (идемпотентного). Если dead_code — верни DELETE FILE. Иначе — минимальный точечный diff целевого файла. Если для корректных контекстных строк нужно увидеть исходный код, верни NEED_CONTEXT с указанием файла.`,
    },
  ];

  try {
    const diff = await callAIWithModelDirect(messages, 'google/gemini-2.0-flash-001');
    return diff?.trim() ?? null;
  } catch {
    return null;
  }
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
    const result = await callAIWithModelDirect(messages, 'google/gemini-2.0-flash-001');
    return result?.trim() ?? null;
  } catch {
    return null;
  }
}

