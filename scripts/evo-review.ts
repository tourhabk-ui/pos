/**
 * scripts/evo-review.ts
 *
 * AI-ревью кода Growth Scan — НА РАННЕРЕ GitHub (§8, вслед за evo-judge.ts).
 *
 * ── Зачем именно на раннере ────────────────────────────────────────────────
 *
 * Прод стоит на Timeweb в РФ: путь к флагману (Claude/GPT) идёт либо через
 * сторонний релей вне РФ (гео-блок Cloudflare — источник многочасовых
 * разборов «ключа нет» vs «ключ есть, ответа нет»), либо через шлюз Timeweb
 * agent.timeweb.cloud (§8), либо съезжает на DeepSeek/Qwen. Раннер GitHub —
 * не в РФ, достигает openrouter.ai/api.anthropic.com напрямую, гео-блока нет.
 * Тот же приём, что `scripts/evo-judge.ts` уже год использует для разбора
 * находок — здесь применён к САМОМУ ревью, а не только к его вердикту.
 *
 * ── Разделение труда с продом ──────────────────────────────────────────────
 *
 * Список файлов на ревью выбирает ПРОД (`GET /api/cron/evo-review-job`) —
 * он читает леджер покрытия (evo_review_ledger) через `pool`, который с
 * раннера недостижим (lib/db-pool.ts резолвит хост во внутренний IP
 * Timeweb). Раннер получает готовый список, читает тела файлов из СВОЕГО
 * checkout (быстрее и надёжнее, чем прод-фоллбэк на GitHub raw), зовёт
 * модель, фильтрует ответ ТЕМИ ЖЕ функциями, что и прод-фоллбэк
 * (filterAndMapReviewFindings — страж не должен зависеть от того, кто позвал
 * модель), и отдаёт готовые находки на публикацию (`POST /api/cron/evo-findings`)
 * отдельным шагом workflow — сам скрипт сети для чтения/записи к проду не
 * трогает, только к провайдеру модели.
 *
 * ── Тишина не считается ответом ────────────────────────────────────────────
 *
 * Нет ключа модели — падаем с внятной ошибкой, а не пишем пустой результат.
 * Модель не ответила — результат называет причину (decision_error), а не
 * молчит нулём находок.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  REVIEW_SYSTEM_PROMPT,
  buildReviewUserMessage,
  buildStaticIssuesForFiles,
  parseAiReviewJson,
  filterAndMapReviewFindings,
  clampForReview,
  type GrowthIssue,
} from '@/lib/agents/evo/growth-agent';
import { callAIDecisionDetailed } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

interface ReviewJob {
  files: string[];
  learned_lessons_block: string;
}

export interface ReviewResult {
  issues: GrowthIssue[];
  static_issues: GrowthIssue[];
  review_files: string[];
  model: string | null;
  decision_error: string | null;
  provenance: string[] | null;
}

/** Читает файл из checkout раннера — тот же клэмп, что у прод-фоллбэка. */
function readFileFromCheckout(relPath: string): string | null {
  try {
    return clampForReview(readFileSync(relPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Собирает результат ревью из уже готового ответа решателя. Чистая функция —
 * под тестом, без файловой системы и без сети.
 */
export function buildReviewResult(
  rawResponse: string | null,
  decisionError: string | null,
  decisionModel: string | null,
  provenance: string[] | null,
  fileContents: Map<string, string>,
  reviewFiles: string[],
): ReviewResult {
  const staticIssues = buildStaticIssuesForFiles(fileContents);

  if (!rawResponse) {
    return { issues: [], static_issues: staticIssues, review_files: reviewFiles, model: decisionModel, decision_error: decisionError, provenance };
  }

  let parsed;
  try {
    parsed = parseAiReviewJson(rawResponse);
  } catch (e) {
    return {
      issues: [], static_issues: staticIssues, review_files: reviewFiles, model: decisionModel,
      decision_error: `ответ ${decisionModel ?? '?'} не распарсился: ${(e as Error).message.slice(0, 120)}`,
      provenance,
    };
  }

  const issues = filterAndMapReviewFindings(parsed, fileContents, decisionModel);
  return { issues, static_issues: staticIssues, review_files: reviewFiles, model: decisionModel, decision_error: null, provenance };
}

async function main(): Promise<void> {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    throw new Error('Использование: evo-review.ts <job.json> <результат.json>');
  }

  // Флагманский путь на раннере — прямой OpenRouter/Anthropic, без релея
  // (см. докстринг файла): гео-блока здесь нет, а Timeweb-шлюз (§8) —
  // сетевой путь, нужный ТОЛЬКО проду. DeepSeek/Qwen остаются фоллбэком.
  const KEYS = ['OPENROUTER_API_KEY', 'OR_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'];
  if (!KEYS.some((k) => process.env[k])) {
    throw new Error(`Нет ни одного ключа модели (${KEYS.join('/')}): ревьюить нечем. Пустой результат был бы враньём.`);
  }

  const job = JSON.parse(readFileSync(inPath, 'utf-8')) as ReviewJob;
  const files = Array.isArray(job.files) ? job.files : [];

  const fileBlocks: string[] = [];
  const fileContents = new Map<string, string>();
  for (const f of files) {
    const content = readFileFromCheckout(f);
    if (content) {
      fileBlocks.push(`━━━ ${f} ━━━\n${content}`);
      fileContents.set(f, content);
    }
  }

  if (fileBlocks.length === 0) {
    const empty: ReviewResult = { issues: [], static_issues: [], review_files: files, model: null, decision_error: 'ни один файл не прочитан из checkout', provenance: null };
    writeFileSync(outPath, JSON.stringify(empty, null, 2));
    console.log('Файлов на ревью нет (или ни один не прочитан) — результат пуст, причина названа.');
    return;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: buildReviewUserMessage(fileBlocks, job.learned_lessons_block ?? '') },
  ];

  const { text, model, error, provenance } = await callAIDecisionDetailed(messages);
  const result = buildReviewResult(text, error ?? null, model ?? null, provenance ?? null, fileContents, files);

  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(
    `Ревью: файлов прочитано ${fileContents.size}, находок ${result.issues.length} (+${result.static_issues.length} детерминированных), ` +
    `модель: ${result.model ?? 'не ответила'}${result.decision_error ? `, причина: ${result.decision_error}` : ''}`,
  );
}

// Запуск только как скрипт: при импорте из теста main не вызывается.
if (process.argv[1] && process.argv[1].endsWith('evo-review.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
