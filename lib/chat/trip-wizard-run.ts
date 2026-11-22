/**
 * Сборка плана мастера «Спланировать поездку» на живых зависимостях: движок —
 * через инструмент Кузьмича (тот же `recommendTrip`, черновик плана), дни —
 * из сохранённого черновика. Модель не зовётся.
 */
import { buildWizardPlan, type WizardScreen, type WizardState } from '@/lib/chat/trip-wizard';

/** Не чаще одной сборки в 15 секунд на чат: движок ходит в базу. */
const BUILD_GAP_MS = 15_000;
const lastBuild = new Map<string, number>();

export function wizardBuildAllowed(channel: 'telegram' | 'max', chatId: number | string, nowMs: number = Date.now()): boolean {
  const key = `${channel}:${chatId}`;
  const last = lastBuild.get(key);
  if (last !== undefined && nowMs - last < BUILD_GAP_MS) return false;
  lastBuild.set(key, nowMs);
  if (lastBuild.size > 5000) {
    for (const [k, t] of lastBuild) if (nowMs - t > BUILD_GAP_MS) lastBuild.delete(k);
  }
  return true;
}

export const WIZARD_BUSY_TEXT = 'Уже собираю план — подождите несколько секунд.';

export async function runWizardPlan(s: WizardState): Promise<WizardScreen> {
  const { makeTripPlanForKuzmich } = await import('@/lib/kuzmich/trip-plan-tool');
  const { loadDraft } = await import('@/lib/planner/plan-drafts');
  return buildWizardPlan(s, {
    makePlan: (args) => makeTripPlanForKuzmich(args, { surface: 'chat' }),
    loadDays: async (id) => {
      const read = await loadDraft(id);
      return read.kind === 'found' ? read.draft.days : null;
    },
    site: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru',
  });
}
