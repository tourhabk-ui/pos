'use client';

import { useState, useEffect, useRef } from 'react';
import { useOfflineGPS } from '@/hooks/useOfflineGPS';
import { checkBreach } from '@/lib/safety/geofence';
import type { GeofenceZone, GeofenceBreach } from '@/lib/safety/geofence';

const ZONES_LS_KEY   = 'vedar_geofence_zones';
// Порог «свежести» — пробуем обновить при наличии сети, но НЕ выбрасываем старый кеш.
// Зоны опасности не переезжают — протухший кеш лучше, чем пустые зоны в поле.
const ZONES_STALE_MS = 10 * 60 * 1_000; // 10 минут

function readCachedZones(): { zones: GeofenceZone[]; stale: boolean } | null {
  try {
    const raw = localStorage.getItem(ZONES_LS_KEY);
    if (!raw) return null;
    const { zones, ts } = JSON.parse(raw) as { zones: GeofenceZone[]; ts: number };
    if (!Array.isArray(zones) || zones.length === 0) return null;
    return { zones, stale: Date.now() - ts > ZONES_STALE_MS };
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

  // Загрузка зон: кеш всегда используется (любого возраста), сеть — оппортунистически.
  // Принцип: «старые зоны лучше пустых» — вулкан не переедет за 10 минут.
  useEffect(() => {
    const cached = readCachedZones();
    if (cached) {
      setZones(cached.zones);
      setLoaded(true);
      // Кеш свежий — не идём в сеть лишний раз
      if (!cached.stale) return;
    }

    if (fetchedRef.current) return;
    fetchedRef.current = true;

    fetch('/api/safety/geofence-zones')
      .then(r => r.json())
      .then((j: { success: boolean; zones: GeofenceZone[] }) => {
        if (j.success && Array.isArray(j.zones) && j.zones.length > 0) {
          setZones(j.zones);
          setLoaded(true);
          writeCachedZones(j.zones);
        }
      })
      .catch(() => { /* офлайн — продолжаем с тем, что есть в кеше */ });
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
