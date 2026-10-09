/**
 * План поездки по plan_id — в заявку из MCP (#2304, шаг 2).
 *
 * Агент собрал план через make_trip_plan, человек сказал «хочу» — и заявка
 * уходила менеджеру одним комментарием, без плана. Теперь create_lead и
 * create_booking_request принимают plan_id, и в заявку ложится та же сводка,
 * что из /planner (lib/planner/plan-for-lead): состав, туры по дням, смета.
 *
 * Исходов три, и ни один не выдаётся за другой (§4.0): план приложен; плана
 * нет (неверный ID или черновику больше 7 дней) — заявка без плана, и агент
 * это слышит; база не ответила — заявка без плана, но номер плана записан,
 * чтобы менеджер нашёл его позже.
 */
import { loadDraft, isDraftId } from '@/lib/planner/plan-drafts';
import { planForLead, type PlanForLead } from '@/lib/planner/plan-for-lead';

export type PlanAttach =
  | { kind: 'none' }
  | { kind: 'attached'; planId: string; plan: PlanForLead }
  | { kind: 'missing'; planId: string }
  | { kind: 'failed'; planId: string };

export async function planFromDraft(planId: string | undefined): Promise<PlanAttach> {
  const id = (planId ?? '').trim();
  if (!id) return { kind: 'none' };
  if (!isDraftId(id)) return { kind: 'missing', planId: id };
  const read = await loadDraft(id);
  if (read.kind === 'missing') return { kind: 'missing', planId: id };
  if (read.kind === 'failed') return { kind: 'failed', planId: id };
  const p = read.draft.params;
  return {
    kind: 'attached',
    planId: id,
    plan: planForLead(read.draft.days, {
      adults: p.adults, children: p.children, budgetTier: p.budgetTier, arrivalDate: p.arrivalDate,
    }),
  };
}

/** Поля для source_data заявки: план — если приложен, номер — если не прочитался. */
export function planSourceFields(a: PlanAttach): Record<string, unknown> {
  if (a.kind === 'attached') return { plan_id: a.planId, plan: a.plan };
  if (a.kind === 'failed') return { plan_id: a.planId };
  return {};
}

/** Что сказать агенту, если план не приложился. Пусто — сказать нечего. */
export function planAttachNote(a: PlanAttach): string {
  if (a.kind === 'missing') return ` План ${a.planId} не найден (неверный ID или плану больше 7 дней) — заявка принята без плана.`;
  if (a.kind === 'failed') return ' План сейчас не прочитался — заявка принята без него, номер плана записан в заявку.';
  return '';
}
