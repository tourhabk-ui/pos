/**
 * Сводка безопасности для страницы плана по ссылке.
 *
 * Черновик хранит дни, а не предупреждения. MCP кладёт сводку МЧС
 * («Мутновский: не приближаться») в блок «Безопасность и разрешения».
 * Страница собирает ту же сводку заново: действующие строки ленты,
 * зоны и тексты дней. Не прочиталось — блока нет, а не пустая «всё спокойно».
 */
import type { ZoneId } from '@/lib/planner/constants';
import type { PlanWarningLike } from '@/lib/planner/day-card-view';
import { planSafetyScope } from '@/lib/planner/official-alerts';
import { loadActiveWarnings } from '@/lib/safety/active-warnings';
import { splitWarningsForTrip, warningDigest, warningsForPlanZones } from '@/lib/safety/mchs-bulletin';

export interface SharedSafetyDay {
  type: string;
  zone: string;
  title: string;
  description?: string | null;
  dayWarnings?: string[] | null;
}

export async function safetyNotesForSharedDays(
  days: readonly SharedSafetyDay[],
  arrival: string | null,
): Promise<PlanWarningLike[]> {
  const loaded = await loadActiveWarnings();
  if (!loaded.ok) return [];
  const { forTrip } = splitWarningsForTrip(loaded.warnings, arrival);
  const scope = planSafetyScope(days.map((d) => ({
    type: d.type,
    zone: d.zone as ZoneId,
    title: d.title,
    description: d.description,
    dayWarnings: d.dayWarnings,
  })));
  const digest = warningDigest(warningsForPlanZones(forTrip, scope.zones, scope.texts));
  if (!digest) return [];
  return [{ type: 'mchs', severity: 'important', message: digest }];
}
