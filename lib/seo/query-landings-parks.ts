/**
 * Парки для посадочных — из справочника parks на запросе, по теме страницы:
 * то же правило слова целиком (matchesTopicText) по названию и описанию парка.
 * Отказ базы — null и лог: блок не показывается, страница не падает.
 */
import { listActiveParks, type ParkListItem } from '@/lib/parks/list';
import { matchesTopicText } from '@/lib/seo/query-landings-data';
import type { LandingTopic } from '@/lib/seo/query-landings';

export function parksForTopic(topic: LandingTopic, parks: readonly ParkListItem[]): ParkListItem[] {
  if (topic === 'all') return [];
  return parks.filter((p) => matchesTopicText(`${p.displayName} ${p.description ?? ''}`, topic));
}

export async function loadLandingParks(topic: LandingTopic): Promise<ParkListItem[] | null> {
  if (topic === 'all') return [];
  try {
    return parksForTopic(topic, await listActiveParks());
  } catch (err) {
    console.error('[query-landing] парки не прочитаны:', topic, err instanceof Error ? err.message : err);
    return null;
  }
}
