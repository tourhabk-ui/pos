import { pool } from '@/lib/db-pool';
import { callAIFast } from '@/lib/ai/providers';
import { searchExternalTools, trackToolUsage } from '@/lib/agents/tools/taaft-search';
import { telegramService } from '@/lib/notifications/telegram';
import { latestScoutDigest } from '@/lib/agents/evo/intel-bridge';

export interface EvolverAnalysisResult {
  analyzed: number;
  proposals: number;
  external_tools_found: number;
  outcomes_analyzed: number;
  avg_kuzmich_score: number | null;
  skipped: boolean;
  duration_ms: number;
}

interface ActionStat {
  action_type: string;
  count: string;
  error_count: string;
  avg_tokens_out: string | null;
  total_cost_usd: string | null;
}

interface AiProposal {
  action_type: string;
  problem: string;
  suggestion: string;
  need_external_tool: boolean;
  tool_query?: string;
}

const COOLDOWN_HOURS = 20;

export async function runEvolverAnalysis(): Promise<EvolverAnalysisResult> {
  const startedAt = Date.now();

  // Skip if already ran in the last 20 hours
  const { rows: lastRunRows } = await pool.query<{ updated_at: string }>(
    `SELECT updated_at FROM agent_memory
     WHERE agent_id = 'evo' AND memory_type = 'evolver_analysis' AND key = 'last_run'
     LIMIT 1`,
  );
  if (lastRunRows.length > 0) {
    const elapsed = Date.now() - new Date(lastRunRows[0].updated_at).getTime();
    if (elapsed < COOLDOWN_HOURS * 60 * 60 * 1000) {
      return { analyzed: 0, proposals: 0, external_tools_found: 0, outcomes_analyzed: 0, avg_kuzmich_score: null, skipped: true, duration_ms: 0 };
    }
  }

  // 1. Aggregate ai_actions_log: last 7 days, group by action_type
  const { rows: stats } = await pool.query<ActionStat>(
    `SELECT
       action_type,
       COUNT(*)::text                                                  AS count,
       COUNT(CASE WHEN metadata->>'error' IS NOT NULL THEN 1 END)::text AS error_count,
       ROUND(AVG(tokens_out))::text                                    AS avg_tokens_out,
       ROUND(SUM(cost_usd), 4)::text                                   AS total_cost_usd
     FROM ai_actions_log
     WHERE created_at > NOW() - INTERVAL '7 days'
     GROUP BY action_type
     ORDER BY
       COUNT(CASE WHEN metadata->>'error' IS NOT NULL THEN 1 END) DESC,
       COUNT(*) DESC
     LIMIT 15`,
  );

  // 1b. Внешняя разведка входит в обсуждение эволюции: последний дайджест Scout
  //     (тренды AI / туриндустрия / Камчатка) — контекст для рассуждения. Если
  //     он есть, эволюция обсуждает наружу даже при тихих внутренних логах.
  const digest = await latestScoutDigest().catch(() => null);
  const externalIntel = digest?.compiled_truth?.trim() || null;

  // 2. Outcomes analysis — параллельно с AI-анализом логов
  const [proposals, outcomesResult] = await Promise.all([
    (stats.length > 0 || externalIntel) ? analyzeWithAI(stats, externalIntel) : Promise.resolve([] as AiProposal[]),
    analyzeKuzmichOutcomes(),
  ]);

  // 3. For each proposal with need_external_tool, search the catalog and notify
  const externalToolsFound = await processProposals(proposals);

  // 4. Mark last run
  await markLastRun(proposals.length);

  return {
    analyzed: stats.length,
    proposals: proposals.length,
    external_tools_found: externalToolsFound,
    outcomes_analyzed: outcomesResult.count,
    avg_kuzmich_score: outcomesResult.avg_score,
    skipped: false,
    duration_ms: Date.now() - startedAt,
  };
}

/**
 * Промпт эволюции. Обсуждает ДВА источника: внутренние action-логи (что
 * ломается/тратит деньги) И внешнюю разведку Scout (что происходит снаружи и
 * что стоит внедрить). Чистая функция — под тестом. externalIntel=null → блок
 * разведки не добавляется (прежнее поведение).
 */
export function buildEvolverPrompt(stats: ActionStat[], externalIntel: string | null): string {
  const intelBlock = externalIntel
    ? `

=== ВНЕШНЯЯ РАЗВЕДКА ЗА СУТКИ (Scout: тренды AI · туриндустрия РФ · Камчатка) ===
${externalIntel.slice(0, 5000)}

Если во внешней разведке есть КОНКРЕТНАЯ, заземлённая в тексте выше возможность для НАШЕЙ платформы (безопасность туристов, маршруты/точки, бронирование, Кузьмич, офлайн, привлечение туристов на Камчатку) — добавь её отдельным issue: action_type="intel:<кратко>", problem=<что во внешнем мире произошло, дословный факт>, suggestion=<что конкретно рассмотреть/сделать>. Только заземлённое в тексте, не выдумывай и не переноси цифры.`
    : '';

  return `Ты оптимизируешь работу AI-агентов платформы TourHab (туризм Камчатки, цель — безопасность туристов). Анализируешь агрегат ai_actions_log за 7 дней и ищешь действия, которые ломаются, тратят деньги впустую или дают пустой ответ. Плюс учитываешь внешнюю разведку — что происходит в мире и что стоит внедрить.

Статистика по action_type:
${JSON.stringify(stats, null, 2)}

Считай action_type проблемным, если выполняется хотя бы одно:
- error_count / count > 0.10 (более 10% вызовов с ошибкой)
- avg_tokens_out < 15 (пустой или обрезанный ответ)
- total_cost_usd > 0.50 при error_count > 0 (платим за неудачи)
- count > 50 при стабильных ошибках (частое массовое действие важнее редкого)

Приоритет: действия Кузьмича, SOS/безопасности и бронирований важнее прочих — выноси первыми.${intelBlock}

Верни JSON без markdown-обёртки:
{"issues":[{"action_type":"...","problem":"...","suggestion":"...","need_external_tool":true,"tool_query":"..."}]}

Требования:
- problem — конкретный факт с цифрой из статистики ("error_count 18 из 40 = 45%") или дословный факт из разведки, не "много ошибок"
- suggestion — конкретное действие ("добавить retry с backoff", "снизить max_tokens до 512", "проверять пустой ответ перед сохранением", "сменить модель в waterfall"), не "оптимизировать промпт"
- need_external_tool = true ТОЛЬКО если задачу не решает наш внутренний callAIWaterfall/callAIFast, а нужен специализированный внешний сервис (распознавание растений/животных по фото, разбор GPX, прогноз лавин, перевод)
- tool_query — на русском, кратко ("определить растение по фото", "анализ GPX-трека")
- Включай только реально проблемные action_type или заземлённые intel-возможности. Не более 5 issues.`;
}

async function analyzeWithAI(stats: ActionStat[], externalIntel: string | null = null): Promise<AiProposal[]> {
  const prompt = buildEvolverPrompt(stats, externalIntel);

  try {
    const raw = await callAIFast([{ role: 'user', content: prompt }]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { issues?: AiProposal[] };
    return Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5) : [];
  } catch {
    return [];
  }
}

async function processProposals(proposals: AiProposal[]): Promise<number> {
  let externalToolsFound = 0;
  const tgLines: string[] = [];

  for (const p of proposals) {
    // Upsert proposal to agent_memory (one record per action_type)
    await pool.query(
      `INSERT INTO agent_memory (agent_id, memory_type, key, value, source)
       VALUES ('evo', 'proposal', $1, $2, 'evolver_analysis')
       ON CONFLICT (agent_id, memory_type, key)
       DO UPDATE SET value = $2, updated_at = NOW()`,
      [`proposal_${p.action_type}`, JSON.stringify(p)],
    );

    if (!p.need_external_tool || !p.tool_query) continue;

    const tools = await searchExternalTools(p.tool_query, 2);
    if (tools.length === 0) continue;

    externalToolsFound += tools.length;
    void Promise.all(tools.slice(0, 1).map((t) => trackToolUsage(t.slug)));

    const tool = tools[0];
    const isFree = tool.is_free ? 'бесплатный' : 'платный';
    tgLines.push(
      `<b>${p.action_type}</b>: ${p.problem}\n` +
      `Инструмент: ${tool.name} (${isFree}) — ${tool.url}`,
    );
  }

  if (tgLines.length > 0) {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (chatId) {
      const text = `<b>Evolver Analysis</b> — найдены внешние инструменты:\n\n${tgLines.join('\n\n')}`;
      void telegramService.sendMessage({
        chatId,
        text: text.slice(0, 2000),
        parseMode: 'HTML',
      });
    }
  }

  return externalToolsFound;
}

interface OutcomesAnalysisResult {
  count: number;
  avg_score: number | null;
}

async function analyzeKuzmichOutcomes(): Promise<OutcomesAnalysisResult> {
  // Читаем outcome-записи за последние 7 дней
  const { rows } = await pool.query<{ compiled_truth: string; created_at: string }>(
    `SELECT compiled_truth, created_at
     FROM agent_knowledge
     WHERE agent_id = 'kuzmich'
       AND type = 'outcome'
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 50`,
  );

  if (rows.length === 0) return { count: 0, avg_score: null };

  // Извлекаем оценки из текста "Оценка N/10"
  const scores: number[] = [];
  const lowQuality: string[] = [];

  for (const row of rows) {
    const match = row.compiled_truth.match(/Оценка (\d+)\/10/);
    if (!match) continue;
    const score = parseInt(match[1]);
    scores.push(score);
    if (score < 7) lowQuality.push(row.compiled_truth.slice(0, 300));
  }

  if (scores.length === 0) return { count: rows.length, avg_score: null };

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  // Если средний балл низкий — просим AI синтезировать проблему
  if (avg < 7 && lowQuality.length >= 3) {
    const synthesis = await callAIFast([{
      role: 'user',
      content: `Ты аудитор качества AI-бота Кузьмич — Хранитель Камчатки на платформе TourHab. Кузьмич помогает туристам: советует маршруты и точки (вулканы, озёра, источники), предупреждает об опасностях (лавины, медведи, термальные источники, погода), объясняет регистрацию МЧС и снаряжение. Хороший ответ: фактически точный по гео-данным Камчатки, безопасность-ориентированный, конкретный (названия, расстояния, сезоны), на русском, без воды и выдуманных фактов.

Вот ${lowQuality.length} ответов с оценкой < 7/10 за неделю:

${lowQuality.slice(0, 10).join('\n---\n')}

Средний балл: ${avg.toFixed(1)}/10.

Классифицируй каждую проблему по типу: фактическая ошибка / выдуманные данные (галлюцинация) / упущенное предупреждение о безопасности / уход от вопроса / вода без конкретики / неверный тон / потеря контекста диалога. Назови 2-3 самые частые причины с типом и примером из текстов выше.

prompt_suggestion должен быть ГОТОВЫМ К ВСТАВКЕ фрагментом системного промпта (конкретное правило), а не описанием намерения. Хорошо: "Если спрашивают о маршруте с координатами — всегда указывай сложность, сезон и обязательность регистрации МЧС". Плохо (запрещён): "сделать ответы дружелюбнее".

Верни JSON без markdown-обёртки: {"main_issues":["тип: описание с примером"],"prompt_suggestion":"готовая инструкция для системного промпта"}`,
    }]);

    if (synthesis) {
      const jsonMatch = synthesis.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        // Сохраняем синтез в agent_memory для будущего ручного применения
        await pool.query(
          `INSERT INTO agent_memory (agent_id, memory_type, key, value, source)
           VALUES ('evo', 'proposal', 'kuzmich_quality', $1, 'outcomes_analysis')
           ON CONFLICT (agent_id, memory_type, key)
           DO UPDATE SET value = $1, updated_at = NOW()`,
          [JSON.stringify({ avg_score: avg, sample_count: scores.length, synthesis: jsonMatch[0] })],
        );

        // Telegram-алерт если качество заметно упало
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (chatId && avg < 6) {
          void telegramService.sendMessage({
            chatId,
            text: `<b>Outcomes Alert</b> — Кузьмич за неделю\n` +
              `Средний балл: <b>${avg.toFixed(1)}/10</b> (${scores.length} оценок)\n` +
              `Синтез проблем сохранён в agent_memory → ключ kuzmich_quality`,
            parseMode: 'HTML',
          });
        }
      }
    }
  }

  return { count: rows.length, avg_score: parseFloat(avg.toFixed(1)) };
}

async function markLastRun(proposalsCount: number): Promise<void> {
  await pool.query(
    `INSERT INTO agent_memory (agent_id, memory_type, key, value, source)
     VALUES ('evo', 'evolver_analysis', 'last_run', $1, 'evolver_analysis')
     ON CONFLICT (agent_id, memory_type, key)
     DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({ ran_at: new Date().toISOString(), proposals: proposalsCount })],
  );
}
