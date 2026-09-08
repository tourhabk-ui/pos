/**
 * Outcomes grader для Kuzmich.
 *
 * После каждого ответа Kuzmich — асинхронная оценка качества через callAIFast.
 * Результаты хранятся в agent_knowledge (type='outcome').
 * Evolver подхватывает записи с низким score на следующем cron/evo цикле.
 */

import { createHash } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { callAIFast } from '@/lib/ai/providers';
import { assessGrounding, type ToolRun } from '@/lib/agents/eval/grounding';
import { detectRefusal } from '@/lib/safety/refusal-detector';

interface OutcomeResult {
  score: number;       // 0–10
  issues: string[];    // описания проблем если score < 6
}

const KUZMICH_RUBRIC = `Оцени ответ чат-бота Кузьмич по шкале 0-10.
Критерии:
- Безопасность: упомянута если вопрос о маршруте/месте/активности (0-3 балла)
- Достоверность: реальные данные, без выдуманных фактов/цен/туров (0-3 балла)
- Тон хранителя: голос места, не менеджер продаж (0-2 балла)
- Полезность: ответ по существу, без лишней воды (0-2 балла)

Верни ТОЛЬКО JSON без пояснений: {"score": <число>, "issues": [<строки проблем>]}
Если проблем нет — issues пустой массив.`;

function isGradableQuestion(text: string): boolean {
  const keywords = [
    'маршрут', 'вулкан', 'поход', 'безопасно', 'опасно', 'медведь',
    'погода', 'снаряжение', 'когда', 'как добраться', 'где', 'что взять',
    'тур', 'экскурсия', 'гид', 'камчатка', 'озеро', 'источник',
  ];
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

/**
 * Отпечаток промпта — 8 hex от SHA-256.
 *
 * Сам промпт в оценку не пишется: он длинный, меняется целиком и в базе
 * знаний не нужен. Нужен ответ на один вопрос — «тот же самый промпт или уже
 * другой», — и отпечаток на него отвечает точно. Тот же приём, что у
 * опознания ключей провайдеров (lib/ai/key-identity).
 */
export function fingerprintPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 8);
}

/**
 * Чем произведён ответ. Всё поля необязательны и по отдельности допускают
 * `null` — «не записано» отличается от «не было» (§4.0): запасной путь идёт
 * без инструментов, а при немоте всех провайдеров имени нет вовсе.
 */
export interface AnswerProvenance {
  /** Отпечаток системного промпта на момент ответа. */
  promptFingerprint?: string;
  /** Кто ответил: deepseek / openrouter / yandex / … либо null. */
  provider?: string | null;
  /** Каким путём: цикл инструментов или запасной водопад. */
  answerPath?: 'tools' | 'waterfall' | null;
  /** Какие инструменты БЫЛИ ПРЕДЛОЖЕНЫ модели (не какие сработали). */
  toolsOffered?: string[];
}

/**
 * Чем произведён ответ — одним куском для обоих путей записи (оценка судьёй и
 * детерминированный отказ). Отсутствующее поле пишется как null: «не
 * записано» отличается от «не было» (§4.0).
 *
 * Без этого «Кузьмич стал отвечать хуже» не разложить на «сменился
 * провайдер», «поправили промпт» и «инструментов не дали»: водопад меняет
 * провайдера молча, а промпт правится со временем.
 */
function buildProvenance(
  opts: ({ toolRuns?: ToolRun[] } & AnswerProvenance) | undefined,
  grounding: string,
  refusal: { refused: boolean; markers: string[] },
): Record<string, unknown> {
  return {
    prompt_fingerprint: opts?.promptFingerprint ?? null,
    provider:           opts?.provider ?? null,
    answer_path:        opts?.answerPath ?? null,
    tools_offered:      opts?.toolsOffered ?? null,
    tools_ran:          opts?.toolRuns?.map(r => r.name) ?? null,
    grounding,
    refused:            refusal.refused,
    refusal_markers:    refusal.markers.length ? refusal.markers : null,
  };
}

/**
 * Запись исхода — ОДНА на оба пути.
 *
 * Своя копия вставки у ветки отказа разошлась бы с веткой оценки ровно так
 * же, как разошлись две копии создания брони (08.09): сначала незаметно,
 * потом дорого.
 */
async function saveOutcome(input: {
  chatId: number;
  userText: string;
  botResponse: string;
  score: number;
  issues: string[];
  provenance: Record<string, unknown>;
}): Promise<void> {
  const slug = `outcome_kuz_${input.chatId}_${Date.now() % 1000000}`;
  const summary = input.issues.length > 0
    ? `Оценка ${input.score}/10. Проблемы: ${input.issues.join('; ')}`
    : `Оценка ${input.score}/10. Хороший ответ.`;

  await pool.query(
    `INSERT INTO agent_knowledge(slug, type, title, compiled_truth, metadata, agent_id, edit_count, created_at, updated_at)
     VALUES($1, 'outcome', $2, $3, $4::jsonb, 'kuzmich', 0, NOW(), NOW())
     ON CONFLICT(slug) DO NOTHING`,
    [
      slug,
      `Оценка ответа: ${input.score}/10`,
      `Вопрос: ${input.userText.slice(0, 150)}\nОтвет: ${input.botResponse.slice(0, 300)}\n\n${summary}`,
      JSON.stringify(input.provenance),
    ],
  );
}

export async function gradeKuzmichResponse(
  userText: string,
  botResponse: string,
  chatId: number,
  opts?: { toolRuns?: ToolRun[] } & AnswerProvenance,
): Promise<void> {
  // Грейдим только содержательные вопросы о Камчатке
  if (!isGradableQuestion(userText)) return;

  // ОТКАЗ — отдельный исход, а не отсутствие ответа (issue #1730).
  //
  // Порог ниже заводился против обрывов связи, и для них он верен. Но отказ
  // короток по природе («не могу помочь с этим вопросом» — меньше пятидесяти
  // знаков), и порог глотал его целиком: ни балла, ни записи, ни следа.
  // Отказ был неотличим от того, что ответа не было.
  //
  // Для советника по безопасности это дорого именно темами: законные вопросы
  // про медведя рядом, фальшфейер, травму и переохлаждение лежат ровно там,
  // где модели отказывают темой целиком. Своего списка запретных тем у нас
  // нет — отказ выносит провайдер, а водопад меняет его молча.
  const refusal = detectRefusal(botResponse);

  // Пропускаем очень короткие ответы (ошибки, перебои) — но НЕ отказы.
  if (botResponse.length < 50 && !refusal.refused) return;

  // Детерминированная метрика заземления (grounding.ts): конкретика
  // (цены/телефоны/наличие мест), за которой не стоит инструмент, ПРИНЁСШИЙ
  // данные, — факты взяты не из БД. Не зависит от AI-судьи, считается всегда.
  //
  // Журнал вызовов не передан — исход `unknown`, и он НЕ равен «заземлено»
  // (§4.0). Прежде здесь стояло `{ ungrounded: false }`: грейдер отвечал
  // «заземлено» на вопрос, которого не проверял (находка аудита 08.09).
  const grounding = assessGrounding(botResponse, opts?.toolRuns);

  // Отказ судить моделью незачем и вредно: судья поставит низкий балл за
  // бесполезность и запишет это как качество ответа, тогда как причина
  // другая — провайдер отказался отвечать по теме. Записываем детерминированно
  // и без вызова AI: балл 0 с явной причиной честнее выдуманной оценки.
  if (refusal.refused) {
    await saveOutcome({
      chatId,
      userText,
      botResponse,
      score: 0,
      issues: [`ОТКАЗ МОДЕЛИ (${refusal.markers.join(', ')}): провайдер не стал отвечать по существу`],
      provenance: buildProvenance(opts, grounding.verdict, { refused: true, markers: refusal.markers }),
    });
    return;
  }

  try {
    const raw = await callAIFast([{
      role: 'user',
      content: `${KUZMICH_RUBRIC}\n\nВОПРОС ПОЛЬЗОВАТЕЛЯ: ${userText.slice(0, 300)}\n\nОТВЕТ КУЗЬМИЧА: ${botResponse.slice(0, 800)}`,
    }]);
    if (!raw) return;

    // Извлекаем JSON из ответа
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const result = JSON.parse(jsonMatch[0]) as OutcomeResult;

    if (typeof result.score !== 'number') return;

    // Сохраняем проблемные (score < 7), незаземлённые и случайные выборки (каждый 10-й)
    // Непроверенность сохраняется тоже: её нельзя ни зачесть в нарушения, ни
    // спрятать — иначе «не смотрели» опять сольётся с «нарушений нет».
    const shouldSave = result.score < 7 || grounding.verdict !== 'grounded' || Math.random() < 0.1;
    if (!shouldSave) return;

    if (grounding.verdict === 'ungrounded') {
      result.issues.push(`НЕЗАЗЕМЛЁННЫЕ ФАКТЫ (${grounding.signals.join(', ')}): ${grounding.reason}`);
    } else if (grounding.verdict === 'unknown') {
      result.issues.push(`ЗАЗЕМЛЕНИЕ НЕ ПРОВЕРЕНО (${grounding.signals.join(', ')}): ${grounding.reason}`);
    }

    await saveOutcome({
      chatId,
      userText,
      botResponse,
      score: result.score,
      issues: result.issues,
      provenance: buildProvenance(opts, grounding.verdict, { refused: false, markers: [] }),
    });
  } catch (err) {
    // Fire-and-forget — ошибка оценки не должна влиять на пользователя.
    // Но молчать нельзя (§4.0): без строки в логе сломанный грейдер
    // неотличим от грейдера, которому нечего сказать.
    logSwallowedFailure('kuzmich-outcomes', 'оценка ответа', err);
  }
}

export interface OutcomeSummary {
  total_graded: number;
  avg_score: number;
  low_quality_count: number;
  /** Ответы с конкретикой (цены/телефоны/наличие) без вызова инструментов данных. */
  ungrounded_count: number;
  /**
   * Отказы модели — отдельно от низких баллов (issue #1730).
   *
   * Отказ входит и в `low_quality_count` (балл 0), но смешивать их нельзя:
   * низкий балл значит «ответили плохо», отказ — «не стали отвечать», и
   * чинятся они в разных местах. Первое — промптом и данными, второе — только
   * сменой провайдера или политикой.
   */
  refused_count: number;
  /** Провайдеры, чьи отказы попали в выборку, с числом отказов у каждого. */
  refusals_by_provider: Record<string, number>;
  recent_issues: string[];
}

export async function getOutcomesSummary(days = 7): Promise<OutcomeSummary> {
  const { rows } = await pool.query<{
    total: string;
    avg_score: string;
    low_count: string;
    ungrounded_count: string;
    refused_count: string;
    refusal_providers: string[];
    issues: string[];
  }>(
    `SELECT
       COUNT(*) AS total,
       AVG(
         CASE
           WHEN compiled_truth ~ 'Оценка (\\d+)/10'
           THEN (regexp_match(compiled_truth, 'Оценка (\\d+)/10'))[1]::int
         END
       )::numeric(4,1) AS avg_score,
       COUNT(*) FILTER (
         WHERE compiled_truth ~ 'Оценка [0-6]/10'
       ) AS low_count,
       COUNT(*) FILTER (
         WHERE compiled_truth LIKE '%НЕЗАЗЕМЛЁННЫЕ ФАКТЫ%'
       ) AS ungrounded_count,
       -- Отказ читается из metadata, а не из текста: текст пишет судья, а
       -- metadata — детерминированный детектор, и второму верить надёжнее.
       COUNT(*) FILTER (
         WHERE metadata->>'refused' = 'true'
       ) AS refused_count,
       -- Провайдер отказавшего: без него «отказы участились» не разложить на
       -- «сменился провайдер» и «изменилась политика прежнего».
       ARRAY_AGG(
         COALESCE(metadata->>'provider', 'не записан')
         ORDER BY created_at DESC
       ) FILTER (WHERE metadata->>'refused' = 'true') AS refusal_providers,
       ARRAY_AGG(
         CASE
           WHEN compiled_truth LIKE '%Проблемы:%'
           THEN substring(compiled_truth FROM 'Проблемы: (.{1,100})')
         END
         ORDER BY created_at DESC
       ) FILTER (WHERE compiled_truth LIKE '%Проблемы:%') AS issues
     FROM agent_knowledge
     WHERE agent_id = 'kuzmich'
       AND type = 'outcome'
       AND created_at > NOW() - $1::interval`,
    [`${days} days`],
  );

  const row = rows[0];
  const byProvider: Record<string, number> = {};
  for (const p of row?.refusal_providers ?? []) {
    byProvider[p] = (byProvider[p] ?? 0) + 1;
  }
  return {
    total_graded: parseInt(row?.total ?? '0'),
    avg_score: parseFloat(row?.avg_score ?? '0'),
    low_quality_count: parseInt(row?.low_count ?? '0'),
    ungrounded_count: parseInt(row?.ungrounded_count ?? '0'),
    refused_count: parseInt(row?.refused_count ?? '0'),
    refusals_by_provider: byProvider,
    recent_issues: (row?.issues ?? []).filter(Boolean).slice(0, 5),
  };
}
