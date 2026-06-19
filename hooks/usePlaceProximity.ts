'use client';

import { useState, useEffect, useRef } from 'react';

export interface NearbyPlace {
  id: string;
  title: string;
  distanceM: number;
}

interface PlaceRef {
  id: string;
  title: string;
  lat: number;
  lng: number;
}

const PROXIMITY_M     = 300;   // показываем промпт в радиусе 300 м
const COOLDOWN_MS     = 6 * 60 * 60 * 1000; // 6 часов per place
const LS_KEY          = 'vedar_place_prompt_seen';
const MIN_PLACES      = 5;     // не показываем пока мало точек загружено

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function wasRecentlyPrompted(placeId: string): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const seen = JSON.parse(raw) as Record<string, number>;
    const ts = seen[placeId];
    return ts != null && Date.now() - ts < COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markPrompted(placeId: string): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const seen: Record<string, number> = raw ? JSON.parse(raw) : {};
    seen[placeId] = Date.now();
    // Чистим старые записи (>7 дней)
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const k of Object.keys(seen)) {
      if (seen[k] < cutoff) delete seen[k];
    }
    localStorage.setItem(LS_KEY, JSON.stringify(seen));
  } catch { /* localStorage недоступен */ }
}

export function usePlaceProximity(
  userPos: { lat: number; lng: number } | null,
  places: PlaceRef[],
): {
  nearbyPlace: NearbyPlace | null;
  dismiss: () => void;
} {
  const [nearbyPlace, setNearbyPlace] = useState<NearbyPlace | null>(null);
  const dismissedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!userPos || places.length < MIN_PLACES) return;

    let closest: (NearbyPlace & { id: string }) | null = null;

    for (const p of places) {
      if (!p.lat || !p.lng) continue;
      if (dismissedRef.current.has(p.id)) continue;
      if (wasRecentlyPrompted(p.id)) continue;

      const d = haversineM(userPos.lat, userPos.lng, p.lat, p.lng);
      if (d <= PROXIMITY_M && (!closest || d < closest.distanceM)) {
        closest = { id: p.id, title: p.title, distanceM: Math.round(d) };
      }
    }

    if (closest) {
      markPrompted(closest.id);
      setNearbyPlace(closest);
    }
  // Проверяем только при смене позиции (не при каждом рендере)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPos?.lat, userPos?.lng]);

  const dismiss = () => setNearbyPlace(null);

  return { nearbyPlace, dismiss };
}
