/**
 * Диагностика молчания агентов-предложенцев (Scout-Innovator, Intelligence-monitor).
 *
 * Оба синтезируют результат из LLM-ответа и при неудаче тихо возвращали пусто —
 * поэтому «0 issues» нельзя было отличить от «LLM упал» / «невалидный JSON» /
 * «модель честно решила, что триггеров нет». Эти чистые функции классифицируют
 * ответ модели в явную причину, которую агент кладёт в результат прогона.
 *
 * Причина видна прямо в HTTP-ответе крон-эндпоинта (его логирует GitHub Action),
 * поэтому следующий прогон сам себя объясняет — без раскопок в прод-логах.
 */

export type Phase1Reason =
  | 'ok'              // ≥1 предложение
  | 'ai_empty'        // модель вернула пустой текст (провайдер молчит)
  | 'parse_error'     // текст есть, но не парсится как JSON
  | 'not_array'       // распарсилось, но не массив
  | 'ai_empty_array'; // валидный [] — модель решила, что острых триггеров нет

/** Снимает markdown-обёртку и классифицирует JSON-массив предложений. */
export function parseProposalArray(raw: string | null | undefined): {
  proposals: unknown[];
  reason: Phase1Reason;
} {
  if (raw == null || raw.trim() === '') return { proposals: [], reason: 'ai_empty' };
  const json = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { proposals: [], reason: 'parse_error' };
  }
  if (!Array.isArray(parsed)) return { proposals: [], reason: 'not_array' };
  if (parsed.length === 0) return { proposals: [], reason: 'ai_empty_array' };
  return { proposals: parsed, reason: 'ok' };
}

export type DomainStatus =
  | 'found'        // модель выдала релевантный finding
  | 'no_signals'   // сигналов для домена не было (RSS пусто)
  | 'ai_empty'     // модель вернула пустой текст
  | 'parse_error'  // текст есть, не JSON
  | 'no_relevant'; // модель: ничего релевантного (summary=null)

/** Классифицирует ответ модели по одному домену intelligence-monitor. */
export function classifyIntelResponse(raw: string | null | undefined): {
  status: Exclude<DomainStatus, 'found' | 'no_signals'> | 'found';
  summary?: string;
  urgency?: string;
  actionItems?: string[];
} {
  if (raw == null || raw.trim() === '') return { status: 'ai_empty' };
  const jsonStr = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed: { summary?: unknown; urgency?: unknown; action_items?: unknown };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { status: 'parse_error' };
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  if (summary === 'null' || summary === '') return { status: 'no_relevant' };
  const urgency = typeof parsed.urgency === 'string' && ['critical', 'notable', 'informational'].includes(parsed.urgency)
    ? parsed.urgency
    : 'informational';
  const actionItems = Array.isArray(parsed.action_items)
    ? parsed.action_items.filter((x): x is string => typeof x === 'string').slice(0, 3)
    : [];
  return { status: 'found', summary, urgency, actionItems };
}

/** Пустой счётчик исходов доменов для агрегации в прогоне. */
export function emptyDomainBreakdown(): Record<DomainStatus, number> {
  return { found: 0, no_signals: 0, ai_empty: 0, parse_error: 0, no_relevant: 0 };
}
