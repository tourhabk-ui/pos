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
import { classifyResponse } from '@/lib/kuzmich/refusal-detector';

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
 * Записать ОТКАЗ модели — отдельным исходом, с именем провайдера.
 *
 * Балла здесь нет и быть не может: оценивать нечего, модель не отвечала на
 * вопрос. Ставить условную единицу значило бы смешать отказ с плохим ответом
 * в одной средней — а чинятся они в разных местах: плохой ответ в промпте и
 * данных, отказ у провайдера или сменой провайдера.
 *
 * Провайдер пишется рядом (метаданные из #1729) и ради него всё и затевалось:
 * водопад меняет провайдера молча, и без имени «Кузьмич иногда отказывает»
 * останется наблюдением, а не находкой.
 */
async function recordRefusal(
  userText: string,
  botResponse: string,
  chatId: number,
  signals: string[],
  opts?: { toolRuns?: ToolRun[] } & AnswerProvenance,
): Promise<void> {
  try {
    const slug = `outcome_kuz_refusal_${chatId}_${Date.now() % 1000000}`;
    const provider = opts?.provider ?? 'провайдер не записан';
    await pool.query(
      `INSERT INTO agent_knowledge(slug, type, title, compiled_truth, metadata, agent_id, edit_count, created_at, updated_at)
       VALUES($1, 'outcome', $2, $3, $4::jsonb, 'kuzmich', 0, NOW(), NOW())
       ON CONFLICT(slug) DO NOTHING`,
      [
        slug,
        `ОТКАЗ МОДЕЛИ (${provider})`,
        `Вопрос: ${userText.slice(0, 150)}\nОтвет: ${botResponse.slice(0, 300)}\n\n`
        + `ОТКАЗ МОДЕЛИ. Признаки: ${signals.join(', ')}. Балла нет: модель не отвечала на вопрос.`,
        JSON.stringify({
          outcome_kind:       'refusal',
          refusal_signals:    signals,
          prompt_fingerprint: opts?.promptFingerprint ?? null,
          provider:           opts?.provider ?? null,
          answer_path:        opts?.answerPath ?? null,
          tools_offered:      opts?.toolsOffered ?? null,
          tools_ran:          opts?.toolRuns?.map(r => r.name) ?? null,
        }),
      ],
    );
  } catch (err) {
    // Молчать нельзя (§4.0): иначе сломанная запись отказов неотличима от
    // того, что отказов не было — ровно та беда, которую этот код и чинит.
    logSwallowedFailure('kuzmich-outcomes', 'запись отказа модели', err);
  }
}

export async function gradeKuzmichResponse(
  userText: string,
  botResponse: string,
  chatId: number,
  opts?: { toolRuns?: ToolRun[] } & AnswerProvenance,
): Promise<void> {
  // Грейдим только содержательные вопросы о Камчатке
  if (!isGradableQuestion(userText)) return;

  // Чем оказался ответ — РАНЬШЕ порога длины (issue #1730).
  //
  // Порог «короче 50 знаков — не грейдим» заводился против обрывов и перебоев,
  // и для них он верен. Но отказ модели короток ПО ПРИРОДЕ: «не могу помочь с
  // этим вопросом» — 32 знака. Значит отказ не попадал в оценку вообще: ни
  // балла, ни записи, ни следа, — и был неотличим от обрыва связи.
  //
  // Своего списка запрещённых тем у платформы нет, то есть отказ выносит
  // ПРОВАЙДЕР, а водопад меняет провайдера молча. Кузьмич при этом советник по
  // безопасности в поле, и наши законные вопросы лежат ровно в темах, по
  // которым модели отказывают целиком: медведь и чем его отпугнуть, кровь,
  // переохлаждение, оружие в разрешённом промысловом районе.
  const kind = classifyResponse(botResponse);

  // Отказ — самостоятельный исход, а не «плохой ответ» и не «нет ответа».
  // Судить его рубрикой нечем: оценивать нечего, и AI-судья тут лишний вызов.
  if (kind.kind === 'refusal') {
    await recordRefusal(userText, botResponse, chatId, kind.signals, opts);
    return;
  }

  // Обрыв и заглушка водопада — по-прежнему мимо оценки: это факт о сети и
  // ключах, чинится в другом месте. Складывать его с отказом значит потерять
  // оба (тот же урок, что у судьи фактчека 22.08).
  if (kind.kind === 'outage') return;

  // Пропускаем очень короткие ответы (ошибки, перебои). Отказ сюда уже не
  // доедет — он разобран выше и записан.
  if (botResponse.length < 50) return;

  // Детерминированная метрика заземления (grounding.ts): конкретика
  // (цены/телефоны/наличие мест), за которой не стоит инструмент, ПРИНЁСШИЙ
  // данные, — факты взяты не из БД. Не зависит от AI-судьи, считается всегда.
  //
  // Журнал вызовов не передан — исход `unknown`, и он НЕ равен «заземлено»
  // (§4.0). Прежде здесь стояло `{ ungrounded: false }`: грейдер отвечал
  // «заземлено» на вопрос, которого не проверял (находка аудита 08.09).
  const grounding = assessGrounding(botResponse, opts?.toolRuns);

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

    const slug = `outcome_kuz_${chatId}_${Date.now() % 1000000}`;
    const summary = result.issues.length > 0
      ? `Оценка ${result.score}/10. Проблемы: ${result.issues.join('; ')}`
      : `Оценка ${result.score}/10. Хороший ответ.`;

    // Чем произведён ответ — рядом с оценкой, а не в другом месте и не
    // задним числом. Без этого «Кузьмич стал отвечать хуже» не разложить на
    // «сменился провайдер», «поправили промпт» и «инструментов не дали»:
    // водопад меняет провайдера молча, а промпт правится со временем.
    // Отсутствующее поле пишется как null — «не записано», не «не было».
    const provenance = {
      prompt_fingerprint: opts?.promptFingerprint ?? null,
      provider:           opts?.provider ?? null,
      answer_path:        opts?.answerPath ?? null,
      tools_offered:      opts?.toolsOffered ?? null,
      tools_ran:          opts?.toolRuns?.map(r => r.name) ?? null,
      grounding:          grounding.verdict,
    };

    await pool.query(
      `INSERT INTO agent_knowledge(slug, type, title, compiled_truth, metadata, agent_id, edit_count, created_at, updated_at)
       VALUES($1, 'outcome', $2, $3, $4::jsonb, 'kuzmich', 0, NOW(), NOW())
       ON CONFLICT(slug) DO NOTHING`,
      [
        slug,
        `Оценка ответа: ${result.score}/10`,
        `Вопрос: ${userText.slice(0, 150)}\nОтвет: ${botResponse.slice(0, 300)}\n\n${summary}`,
        JSON.stringify(provenance),
      ],
    );
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
   * Отказы модели — СЧИТАЮТСЯ ОТДЕЛЬНО от низких баллов (issue #1730).
   *
   * Сложить их значило бы усреднить две разные беды: плохой ответ чинится в
   * промпте и данных, отказ — у провайдера или сменой провайдера. И отказ не
   * входит в `total_graded`: он не оценивался, оценивать было нечего.
   */
  refusal_count: number;
  recent_issues: string[];
}

export async function getOutcomesSummary(days = 7): Promise<OutcomeSummary> {
  const { rows } = await pool.query<{
    total: string;
    avg_score: string;
    low_count: string;
    ungrounded_count: string;
    refusal_count: string;
    issues: string[];
  }>(
    `SELECT
       -- Оценённые — только те, у кого есть балл. Отказ баллом не обладает, и
       -- считать его «оценённым» значило бы завысить объём проверки ровно на
       -- те случаи, которые никто не проверял (§4.0).
       COUNT(*) FILTER (WHERE compiled_truth ~ 'Оценка (\\d+)/10') AS total,
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
       COUNT(*) FILTER (
         WHERE metadata->>'outcome_kind' = 'refusal'
       ) AS refusal_count,
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
  return {
    total_graded: parseInt(row?.total ?? '0'),
    avg_score: parseFloat(row?.avg_score ?? '0'),
    low_quality_count: parseInt(row?.low_count ?? '0'),
    ungrounded_count: parseInt(row?.ungrounded_count ?? '0'),
    refusal_count: parseInt(row?.refusal_count ?? '0'),
    recent_issues: (row?.issues ?? []).filter(Boolean).slice(0, 5),
  };
}
