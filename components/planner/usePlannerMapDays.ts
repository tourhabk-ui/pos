'use client';
/**
 * Дни плана для карты: день с туром, который движок поставил в точку
 * «Петропавловск по умолчанию», встаёт в место тура из каталога мест
 * (lib/planner/map-tour-points). Пока места не прочитаны или не нашлись —
 * дни такие, как пришли от движка: карта работает и без этого шага.
 */
import { useEffect, useMemo, useState } from 'react';
import type { PlannerMapDay } from '@/lib/planner/map-markers';
import {
  loadCatalogPlaces, loadTourLocations, placeDaysOnMap, toursToPlace,
  type CatalogPlace,
} from '@/lib/planner/map-tour-points';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

type DayWithTour = PlannerMapDay & { realTour?: { tourId?: string | number | null } | null };

export function usePlannerMapDays<T extends DayWithTour>(days: readonly T[]): T[] {
  const [places, setPlaces] = useState<CatalogPlace[]>([]);
  const [locations, setLocations] = useState<Record<string, string>>({});
  const wanted = useMemo(() => toursToPlace(days), [days]);
  const wantedKey = wanted.join(',');
  // Туры, чьё место уже спрашивали, — без повторов на каждую правку дня.
  const missing = wanted.filter(id => !(id in locations));
  const missingKey = missing.join(',');

  useEffect(() => {
    if (!missingKey) return;
    let cancelled = false;
    const ids = missingKey.split(',');
    Promise.all([loadCatalogPlaces(), loadTourLocations(ids)])
      .then(([pl, locs]) => {
        if (cancelled) return;
        setPlaces(pl);
        // Не нашлось — пустая строка: больше не спрашивать.
        setLocations(prev => ({ ...prev, ...Object.fromEntries(ids.map(id => [id, locs[id] ?? ''])) }));
      })
      .catch((err: unknown) => {
        // Каталог мест не ответил — дни остаются в точках движка.
        logSwallowedFailure('planner-map', 'catalog-places', err);
      });
    return () => { cancelled = true; };
  }, [missingKey]);

  return useMemo(
    () => (wantedKey && places.length > 0 ? placeDaysOnMap(days, locations, places) : [...days]),
    [days, wantedKey, places, locations],
  );
}
