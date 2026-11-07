/**
 * Id плана поездки в ответах и в разговоре (аудит планировщика 07.11, K6, K7).
 *
 * До этого id плана жил только в тексте ответа модели: история веб-чата
 * хранит итоговый текст, а инструмента «прочитать мой черновик» нет. Модель
 * не повторила строку «ID плана» — и правку «рейс задержался» вызвать нечем,
 * а заявка из чата уходила без плана, хотя он был собран тут же.
 *
 * Теперь ответ, в ходе которого цикл собрал или поправил план, несёт его id
 * меткой (`planId` у сообщения истории), и следующий ход знает план
 * разговора: цикл Кузьмича получает его строкой контекста, заявка из чата —
 * полем `plan_id`. Метка в модель не уходит: история идёт туда только ролью и
 * текстом (buildMessageHistory, цикл).
 *
 * Модуль лёгкий намеренно — без движка планера: его зовёт роут чата.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_ID_RE = /ID плана: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Id плана из ответа make_trip_plan / edit_trip_plan — для ссылки «продолжить
 * в Ведаре» у MCP (lib/mcp/handoff-targets) и для чата. Разбирается
 * собственный текст инструмента, а не аргумент агента; формат держит
 * planIdLine (lib/kuzmich/trip-plan-tool), и тест сверяет их друг с другом.
 */
export function planIdFromAnswer(answer: string): string | null {
  return PLAN_ID_RE.exec(answer)?.[1] ?? null;
}

const PLAN_TOOLS = new Set(['make_trip_plan', 'edit_trip_plan']);

/** План, который собрал или поправил этот ход: последний вывод инструмента плана. */
export function planIdOfTurn(runs: ReadonlyArray<{ name: string; output?: string }>): string | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (!PLAN_TOOLS.has(run.name) || !run.output) continue;
    const id = planIdFromAnswer(run.output);
    if (id) return id;
  }
  return null;
}

/**
 * Последний план разговора: метка ответа, а у старых ответов без метки —
 * строка «ID плана» в их тексте. Реплики человека не читаются: id плана
 * пишет инструмент, а не собеседник.
 */
export function latestChatPlanId(
  history: ReadonlyArray<{ role: string; content: string; planId?: unknown }>,
): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.planId === 'string' && UUID.test(m.planId)) return m.planId;
    const id = planIdFromAnswer(m.content);
    if (id) return id;
  }
  return null;
}

/** Строка контекста цикла: план разговора и как его править. Нет плана — пусто. */
export function chatPlanContext(planId: string | null): string {
  if (!planId) return '';
  return `План поездки этого разговора уже собран: ID плана: ${planId}. `
    + 'Правка этого плана (день, жильё, задержка рейса) — edit_trip_plan с этим ID; '
    + 'новый make_trip_plan — только если человек просит другую поездку.';
}
