/**
 * lib/home/season-fishing.ts
 *
 * Сколько живых туров на рыбалку в витрине — для ссылки «Туры на рыбалку (N)»
 * в блоке «Сейчас на Камчатке» (components/homepage/SeasonNow). Число берётся
 * из сводки каталога (lib/search/tour-search, queryCatalogSummary), своего
 * запроса нет: главная и каталог обязаны называть одно число.
 */
import type { CatalogSummary } from '@/lib/search/tour-search';

/** Тип активности рыбалки — тот же, что в чипе «Рыбалка» (lib/home/intent-chips). */
export const FISHING_ACTIVITY = 'fishing';

export function fishingTourCount(summary: Pick<CatalogSummary, 'byActivity'>): number {
  return summary.byActivity.find((a) => a.activity_type === FISHING_ACTIVITY)?.count ?? 0;
}
