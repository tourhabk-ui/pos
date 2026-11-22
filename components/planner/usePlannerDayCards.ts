'use client';
/**
 * Карточки мест у дней плана (lib/planner/day-place-cards): день с туром —
 * место тура из каталога мест, день с маршрутом с карты — маршрут каталога.
 * Пока данные не пришли или не нашлись — карточки нет, план работает как был.
 * Подряд одно и то же место (дни многодневного тура) — карточка у первого дня.
 */
import { useEffect, useMemo, useState } from 'react';
import { dayTourId, loadCatalogPlaces, loadTourLocations, placeForLocation, type CatalogPlace } from '@/lib/planner/map-tour-points';
import { placeCardFromDetail, routeCard, type DayPlaceCard } from '@/lib/planner/day-place-cards';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const DAY_CARDS_MAX_PLACES = 10;
const DETAIL_TIMEOUT_MS = 6000;

type CardDay = {
  day: number;
  title: string;
  description?: string;
  routeId?: string;
  realTour?: { tourId?: string | number | null } | null;
};

const detailCache = new Map<string, DayPlaceCard | null>();

async function loadPlaceCard(id: string): Promise<DayPlaceCard | null> {
  if (detailCache.has(id)) return detailCache.get(id) ?? null;
  const r = await fetch(`/api/places/${encodeURIComponent(id)}?view=0`, { signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS) });
  if (!r.ok) { detailCache.set(id, null); return null; }
  const j = await r.json() as { success?: boolean; data?: Record<string, unknown> };
  const card = j?.success ? placeCardFromDetail(j.data) : null;
  detailCache.set(id, card);
  return card;
}

export function usePlannerDayCards(days: readonly CardDay[]): Record<number, DayPlaceCard> {
  const [places, setPlaces] = useState<CatalogPlace[]>([]);
  const [locations, setLocations] = useState<Record<string, string>>({});
  const [cards, setCards] = useState<Record<string, DayPlaceCard | null>>({});

  const tourIds = useMemo(() => [...new Set(days.map(dayTourId).filter((x): x is string => !!x))], [days]);
  const tourKey = tourIds.join(',');

  useEffect(() => {
    if (!tourKey) return;
    let cancelled = false;
    Promise.all([loadCatalogPlaces(), loadTourLocations(tourKey.split(','))])
      .then(([pl, locs]) => { if (!cancelled) { setPlaces(pl); setLocations(locs); } })
      .catch((err: unknown) => logSwallowedFailure('planner-day-cards', 'catalog-places', err));
    return () => { cancelled = true; };
  }, [tourKey]);

  // День → id места каталога (по месту тура).
  const placeOfDay = useMemo(() => {
    const out: Record<number, string> = {};
    if (places.length === 0) return out;
    for (const d of days) {
      const tid = dayTourId(d);
      const loc = tid ? locations[tid] : undefined;
      const place = loc ? placeForLocation(loc, places) : null;
      if (place?.id) out[d.day] = place.id;
    }
    return out;
  }, [days, places, locations]);

  const placeIds = useMemo(() => [...new Set(Object.values(placeOfDay))].slice(0, DAY_CARDS_MAX_PLACES), [placeOfDay]);
  const missingKey = placeIds.filter(id => !(id in cards)).join(',');

  useEffect(() => {
    if (!missingKey) return;
    let cancelled = false;
    const ids = missingKey.split(',');
    Promise.all(ids.map(id => loadPlaceCard(id).catch((err: unknown) => {
      // Место не прочиталось — у дня нет карточки, план цел.
      logSwallowedFailure('planner-day-cards', 'place-detail', err);
      return null;
    }))).then(list => {
      if (cancelled) return;
      setCards(prev => ({ ...prev, ...Object.fromEntries(ids.map((id, i) => [id, list[i]])) }));
    });
    return () => { cancelled = true; };
  }, [missingKey]);

  return useMemo(() => {
    const out: Record<number, DayPlaceCard> = {};
    let prevKey: string | null = null;
    for (const d of days) {
      let card: DayPlaceCard | null = null;
      if (d.routeId) card = routeCard({ id: d.routeId, title: d.title, description: d.description ?? null });
      else if (placeOfDay[d.day]) card = cards[placeOfDay[d.day]] ?? null;
      const key = card ? `${card.kind}:${card.id}` : null;
      if (card && key !== prevKey) out[d.day] = card;
      prevKey = key;
    }
    return out;
  }, [days, placeOfDay, cards]);
}
