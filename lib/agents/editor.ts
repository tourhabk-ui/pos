/**
 * lib/agents/editor.ts
 *
 * Editor — AI-редактор описаний маршрутов.
 * Запускается раз в сутки через /api/cron/editor.
 *
 * Источник: agent_route_knowledge (1386 маршрутов Камчатки).
 * Критерий: description IS NULL или LENGTH(description) < 300.
 * Действие: генерирует описание через AI → UPDATE agent_route_knowledge.
 * Лимит: 15 маршрутов за запуск.
 */

import { pool } from '@/lib/db-pool';
import { callAIFast, callFugu } from '@/lib/ai/providers';
import { ExperimentTracker } from '@/lib/agents/learning/experiment-tracker';
import type { AgentBriefing } from '@/lib/agents/warmup';
import type { ChatMessage } from '@/lib/ai/prompts';

// A/B: вариант B — Sakana Fugu Ultra напрямую (НЕ через OpenRouter — он недоступен).
// Новое имя эксперимента, чтобы старые мусорные данные (Gemma-через-OpenRouter,
// тихо падавшая на waterfall) не смешивались с чистыми замерами Fugu.
const EXP_NAME = 'editor-fugu-vs-waterfall';

export interface EditorResult {
  processed: number;
  improved: number;
  improved_titles: string[];
  improved_ids: string[];  // ark_id / route.id — для smoke test по конкретным строкам
  errors: number;
  duration_ms: number;
}

const BATCH_SIZE = 30;
const MIN_DESCRIPTION_LENGTH = 300;

async function tgSend(text: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* silent */ }
}

interface RouteRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
}

async function findRoutesNeedingDescription(): Promise<RouteRow[]> {
  const { rows } = await pool.query<RouteRow>(`
    SELECT id, title, description, category
    FROM agent_route_knowledge
    WHERE description IS NULL
       OR LENGTH(description) < $1
    ORDER BY RANDOM()
    LIMIT $2
  `, [MIN_DESCRIPTION_LENGTH, BATCH_SIZE]);
  return rows;
}

const CATEGORY_LABELS: Record<string, string> = {
  vulkani:              'вулкан',
  termalnye_istochniki: 'термальные источники',
  geyzery:              'гейзеры',
  eco:                  'экотуризм',
  trekking:             'треккинг',
  lakes:                'озёра',
  rivers:               'реки',
  mountains:            'горы',
  rybalka:              'рыбалка',
  morskie_progulki:     'морские прогулки',
  vertoletnye_tury:     'вертолётные туры',
  medvedi:              'наблюдение за медведями',
  ekskursii:            'экскурсии',
  dzhip:                'джип-туры',
  ozera:                'озёра',
};

async function generateRouteDescription(
  route: RouteRow,
  experimentId?: string,
  tracker?: ExperimentTracker,
): Promise<string | null> {
  const categoryLabel = route.category ? (CATEGORY_LABELS[route.category] ?? route.category) : '';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты эксперт по туризму на Камчатке. Пишешь краткие, точные описания природных объектов и маршрутов для туристической платформы TourHab.
Стиль: фактически точный, живой, без рекламных штампов. Без emoji. Без markdown.
Длина: 2-3 абзаца, 200-350 слов. Упоминай конкретные детали (координаты, высоту, особенности) если знаешь.`,
    },
    {
      role: 'user',
      content: `Напиши описание для туристического объекта:
Название: ${route.title}
${categoryLabel ? `Тип: ${categoryLabel}` : ''}
${route.description ? `Имеющееся описание (расширь и улучши): ${route.description}` : 'Описания нет — создай с нуля на основе названия.'}

Описание должно помочь туристу понять: что это за место, чем оно уникально, когда лучше посещать, что стоит знать перед поездкой.`,
    },
  ];

  if (experimentId && tracker) {
    const variant = tracker.pickVariant(experimentId);
    const t0 = Date.now();
    try {
      if (variant === 'b') {
        // Вариант B — Fugu напрямую. Если Fugu недоступен (нет ключа / ошибка),
        // НЕ засчитываем замер в B (иначе waterfall маскируется под Fugu),
        // а для прода падаем на waterfall, чтобы маршрут всё равно получил описание.
        const fugu = (await callFugu(messages))?.trim() ?? null;
        if (fugu === null) {
          // Замер пропущен — провайдер B не ответил. Чистота статистики важнее.
          const fallback = (await callAIFast(messages))?.trim() ?? null;
          return fallback;
        }
        const ok = fugu.length >= 100;
        await tracker.recordResult(experimentId, 'b', ok ? 'success' : 'fail', Date.now() - t0).catch(() => {});
        return fugu;
      }
      const text = (await callAIFast(messages))?.trim() ?? null;
      const ok = !!text && text.length >= 100;
      await tracker.recordResult(experimentId, 'a', ok ? 'success' : 'fail', Date.now() - t0).catch(() => {});
      return text;
    } catch {
      // Реальная ошибка варианта (а не отсутствие провайдера) — это валидный fail
      await tracker.recordResult(experimentId, variant, 'fail', Date.now() - t0).catch(() => {});
      return null;
    }
  }

  try {
    const result = await callAIFast(messages);
    return result?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function runEditor(briefing?: AgentBriefing): Promise<EditorResult> {
  const start = Date.now();
  let processed = 0;
  let improved  = 0;
  let errors    = 0;

  if (briefing?.platformSummary) {
    // Platform state is available — could be used for future smart prioritisation.
    // For now, presence of recentRuns lets us detect rapid re-runs (same day).
  }

  const improvedTitles: string[] = [];
  const improvedIds: string[] = [];

  // A/B experiment: current waterfall (A) vs Sakana Fugu Ultra (B)
  const tracker = new ExperimentTracker();
  let experimentId: string | undefined;
  try {
    const exp = await tracker.findOrCreate({
      name: EXP_NAME,
      description: 'Sakana Fugu Ultra (прямой API) vs callAIFast waterfall для генерации описаний маршрутов Камчатки',
      intent: 'route_description_generation',
      variant_a: { model: 'waterfall', label: 'callAIFast (текущий)' },
      variant_b: { model: 'fugu-ultra', label: 'Sakana Fugu Ultra (direct)' },
      metric: 'success_rate',
    });
    experimentId = exp.id;
  } catch { /* experiment tracking не критично — продолжаем без него */ }

  let routes: RouteRow[];
  try {
    routes = await findRoutesNeedingDescription();
  } catch {
    return { processed: 0, improved: 0, improved_titles: [], improved_ids: [], errors: 1, duration_ms: Date.now() - start };
  }

  for (const route of routes) {
    processed++;
    const newDescription = await generateRouteDescription(route, experimentId, tracker);
    if (!newDescription || newDescription.length < 100) {
      errors++;
      continue;
    }
    try {
      await pool.query(
        `UPDATE agent_route_knowledge SET description = $1 WHERE id = $2`,
        [newDescription, route.id],
      );
      improved++;
      improvedTitles.push(route.title);
      improvedIds.push(route.id);
    } catch {
      errors++;
    }
  }

  if (improved > 0) {
    let remaining = 0;
    try {
      const { rows } = await pool.query<{ cnt: string }>(
        'SELECT COUNT(*)::text AS cnt FROM agent_route_knowledge WHERE description IS NULL OR LENGTH(description) < $1',
        [MIN_DESCRIPTION_LENGTH]
      );
      remaining = Number(rows[0]?.cnt ?? 0);
    } catch { /* fallback */ remaining = -1; }

    const titlesList = improvedTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    await tgSend(
      `<b>Editor</b> — улучшил ${improved} описаний\n` +
      `(обработано: ${processed}, ошибок: ${errors}, осталось кратких: ${remaining >= 0 ? remaining : '?'})\n\n` +
      `<b>Улучшенные маршруты и локации:</b>\n${titlesList}`,
    );
  }

  // Уведомить когда эксперимент наберёт достаточно данных
  if (experimentId) {
    try {
      const expResults = await tracker.calculateResults(experimentId);
      if (expResults.winner !== null) {
        const winnerLabel = expResults.winner === 'tie'
          ? 'Ничья'
          : expResults.winner === 'a'
            ? 'Waterfall (A) победил'
            : 'Gemma 4 (B) победил';
        await tgSend(
          `<b>A/B эксперимент Editor завершён</b>\n\n` +
          `${winnerLabel}\n\n` +
          `Waterfall: ${expResults.variant_a.success}/${expResults.variant_a.success + expResults.variant_a.fail} (${Math.round(expResults.variant_a.rate * 100)}%)\n` +
          `Gemma 4:   ${expResults.variant_b.success}/${expResults.variant_b.success + expResults.variant_b.fail} (${Math.round(expResults.variant_b.rate * 100)}%)\n\n` +
          `Всего замеров: ${expResults.total}`,
        );
        await tracker.updateStatus(experimentId, 'completed', expResults.winner === 'tie' ? undefined : expResults.winner);
      }
    } catch { /* трекинг не критичен */ }
  }

  return { processed, improved, improved_titles: improvedTitles, improved_ids: improvedIds, errors, duration_ms: Date.now() - start };
}
