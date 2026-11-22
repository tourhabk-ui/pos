'use client';
/**
 * Карточки мест у дней плана на /planner. Выбор — общий с сервером
 * (lib/planner/day-place-cards: placeIdsForDays, assignDayCards); здесь
 * только загрузка через API и память вкладки. Пока данные не пришли — карточек
 * нет, план работает как был.
 */
import { useEffect, useMemo, useState } from 'react';
import { dayTourId, loadCatalogPlaces, loadTourLocations, type CatalogPlace } from '@/lib/planner/map-tour-points';
import {
  assignDayCards, placeCardFromDetail, placeIdsForDays, DAY_CARDS_MAX_PLACES,
  type DayPlaceCard, type DayPlaceSource,
} from '@/lib/planner/day-place-cards';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

const DETAIL_TIMEOUT_MS = 6000;
const detailCache = new Map<string, DayPlaceCard | null>();

async function loadPlaceCard(id: string): Promise<DayPlaceCard | null> {
  if (detailCache.has(id)) return detailCache.get(id) ?? null;
  // view=0: карточка у дня — не визит на страницу места.
  const r = await fetch(`/api/places/${encodeURIComponent(id)}?view=0`, { signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS) });
  if (!r.ok) { detailCache.set(id, null); return null; }
  const j = await r.json() as { success?: boolean; data?: Record<string, unknown> };
  const card = j?.success ? placeCardFromDetail(j.data) : null;
  detailCache.set(id, card);
  return card;
}

export function usePlannerDayCards(days: readonly DayPlaceSource[]): Record<number, DayPlaceCard> {
  const [places, setPlaces] = useState<CatalogPlace[]>([]);
  const [locations, setLocations] = useState<Record<string, string>>({});
  const [cards, setCards] = useState<Record<string, DayPlaceCard | null>>({});

  const tourKey = useMemo(
    () => [...new Set(days.filter(d => !d.routeId).map(dayTourId).filter((x): x is string => !!x))].join(','),
    [days],
  );

  useEffect(() => {
    if (!tourKey) return;
    let cancelled = false;
    Promise.all([loadCatalogPlaces(), loadTourLocations(tourKey.split(','))])
      .then(([pl, locs]) => { if (!cancelled) { setPlaces(pl); setLocations(locs); } })
      .catch((err: unknown) => logSwallowedFailure('planner-day-cards', 'catalog-places', err));
    return () => { cancelled = true; };
  }, [tourKey]);

  const placeOfDay = useMemo(() => placeIdsForDays(days, locations, places), [days, locations, places]);
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
      if (!cancelled) setCards(prev => ({ ...prev, ...Object.fromEntries(ids.map((id, i) => [id, list[i]])) }));
    });
    return () => { cancelled = true; };
  }, [missingKey]);

  return useMemo(() => assignDayCards(days, placeOfDay, cards), [days, placeOfDay, cards]);
}
