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
 *
 * С аудита планировщика 07.11 (M7) план принимают все шесть записей: жильё,
 * машина под заказ, прокат и поездка целиком — тоже. Люди и даты, которых
 * агент не назвал, берутся из плана; названные и расходящиеся с планом —
 * остаются, а расхождение называется в ответе (`planPeople`, `planWindowNote`).
 */
import { loadDraft, isDraftId, type PlanDraft } from '@/lib/planner/plan-drafts';
import { planForLead, type PlanForLead } from '@/lib/planner/plan-for-lead';
import { shiftDate } from '@/lib/analytics/kamchatka-day';

/** Факты плана, из которых заявка берёт умолчания. */
export interface PlanFacts {
  /** Первый и последний день поездки, YYYY-MM-DD включительно. */
  arrivalDate: string;
  departureDate: string;
  /** Взрослых и детей вместе. */
  people: number;
  /** Тур плана → дата его первого дня. */
  tourDates: Record<string, string>;
}

export type PlanAttach =
  | { kind: 'none' }
  | { kind: 'attached'; planId: string; plan: PlanForLead; facts: PlanFacts }
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
    facts: planFacts(read.draft),
  };
}

function planFacts(draft: Pick<PlanDraft, 'params' | 'days'>): PlanFacts {
  const p = draft.params;
  const tourDates: Record<string, string> = {};
  for (const d of draft.days) {
    const id = d.realTour?.tourId;
    // Первый день тура — его дата; дни продолжения многодневного тура позже.
    if (id && !(id in tourDates)) tourDates[id] = shiftDate(p.arrivalDate, d.day - 1);
  }
  return {
    arrivalDate: p.arrivalDate,
    departureDate: p.departureDate,
    people: p.adults + p.children.length,
    tourDates,
  };
}

/**
 * Сколько человек в заявке. Не названо — из плана, и это сказано; названо и
 * расходится с планом — названное, и расхождение тоже сказано: менеджер и
 * агент должны видеть, что заявка не на тот состав, что в плане.
 */
export function planPeople(a: PlanAttach, given: number | undefined): { value: number | undefined; note: string } {
  if (a.kind !== 'attached') return { value: given, note: '' };
  const planned = a.facts.people;
  if (given === undefined) return { value: planned, note: ` Число людей взято из плана: ${planned}.` };
  if (given !== planned) return { value: given, note: ` В плане ${planned} чел., в заявке — ${given}: заявка на ${given}.` };
  return { value: given, note: '' };
}

/** Даты заявки вне дат плана — словами; внутри или плана нет — пусто. */
export function planWindowNote(a: PlanAttach, from: string, to?: string | null): string {
  if (a.kind !== 'attached') return '';
  const end = to ?? from;
  if (from >= a.facts.arrivalDate && end <= a.facts.departureDate) return '';
  const said = to && to !== from ? `${from} — ${to}` : from;
  return ` Даты заявки (${said}) выходят за даты плана (${a.facts.arrivalDate} — ${a.facts.departureDate}): заявка — на названные.`;
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
