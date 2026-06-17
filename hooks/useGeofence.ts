'use client';

import { useState, useEffect, useRef } from 'react';
import { useOfflineGPS } from '@/hooks/useOfflineGPS';
import { checkBreach } from '@/lib/safety/geofence';
import type { GeofenceZone, GeofenceBreach } from '@/lib/safety/geofence';

const ZONES_LS_KEY  = 'vedar_geofence_zones';
const ZONES_TTL_MS  = 10 * 60 * 1_000; // 10 минут

function readCachedZones(): GeofenceZone[] | null {
  try {
    const raw = localStorage.getItem(ZONES_LS_KEY);
    if (!raw) return null;
    const { zones, ts } = JSON.parse(raw) as { zones: GeofenceZone[]; ts: number };
    if (Date.now() - ts > ZONES_TTL_MS) return null;
    return zones;
  } catch {
    return null;
  }
}

function writeCachedZones(zones: GeofenceZone[]): void {
  try {
    localStorage.setItem(ZONES_LS_KEY, JSON.stringify({ zones, ts: Date.now() }));
  } catch { /* localStorage может быть недоступен */ }
}

interface GeofenceState {
  breach: GeofenceBreach | null;
  zonesLoaded: boolean;
}

/**
 * Следит за GPS-позицией через useOfflineGPS и проверяет попадание в опасные зоны.
 * Зоны кешируются в localStorage для работы без интернета.
 */
export function useGeofence(): GeofenceState {
  const { lastPosition }           = useOfflineGPS();
  const [zones, setZones]          = useState<GeofenceZone[]>([]);
  const [zonesLoaded, setLoaded]   = useState(false);
  const [breach, setBreach]        = useState<GeofenceBreach | null>(null);
  const fetchedRef                 = useRef(false);

  // Загрузка зон: сначала кеш, потом сеть
  useEffect(() => {
    const cached = readCachedZones();
    if (cached) {
      setZones(cached);
      setLoaded(true);
    }

    if (fetchedRef.current) return;
    fetchedRef.current = true;

    fetch('/api/safety/geofence-zones')
      .then(r => r.json())
      .then((j: { success: boolean; zones: GeofenceZone[] }) => {
        if (j.success && Array.isArray(j.zones)) {
          setZones(j.zones);
          setLoaded(true);
          writeCachedZones(j.zones);
        }
      })
      .catch(() => { /* офлайн — используем кеш */ });
  }, []);

  // Проверка бреча при каждом обновлении позиции
  useEffect(() => {
    if (!lastPosition || !zones.length) {
      setBreach(null);
      return;
    }
    const result = checkBreach(
      lastPosition.lat,
      lastPosition.lng,
      lastPosition.accuracy,
      zones,
    );
    setBreach(result);
  }, [lastPosition, zones]);

  return { breach, zonesLoaded };
}
