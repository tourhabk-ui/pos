'use client';

import { useState, useEffect, useRef } from 'react';
import { useOfflineGPS } from '@/hooks/useOfflineGPS';
import { activeZones, checkBreach, isPositionFreshForGeofence } from '@/lib/safety/geofence';
import type { GeofenceZone, GeofenceBreach } from '@/lib/safety/geofence';

const ZONES_LS_KEY   = 'vedar_geofence_zones';
// Порог «свежести» — пробуем обновить при наличии сети, но НЕ выбрасываем старый кеш.
// Зоны опасности не переезжают — протухший кеш лучше, чем пустые зоны в поле.
const ZONES_STALE_MS = 10 * 60 * 1_000; // 10 минут

function readCachedZones(): { zones: GeofenceZone[]; stale: boolean; ageMs: number } | null {
  try {
    const raw = localStorage.getItem(ZONES_LS_KEY);
    if (!raw) return null;
    const { zones, ts } = JSON.parse(raw) as { zones: GeofenceZone[]; ts: number };
    if (!Array.isArray(zones)) return null;
    // Постоянные зоны переживают любую давность кэша — наблюдения нет.
    // Отсеиваются ЗДЕСЬ, а не только при проверке близости: иначе истёкшее
    // наблюдение продолжало бы считаться «зоны загружены», и кэш из одних
    // просроченных записей выглядел бы полным.
    const live = activeZones(zones);
    if (live.length === 0) return null;
    const ageMs = Date.now() - ts;
    return { zones: live, stale: ageMs > ZONES_STALE_MS, ageMs };
  } catch {
    return null;
  }
}

function writeCachedZones(zones: GeofenceZone[]): void {
  try {
    localStorage.setItem(ZONES_LS_KEY, JSON.stringify({ zones, ts: Date.now() }));
  } catch { /* localStorage может быть недоступен */ }
}

/**
 * Обновить кеш зон по сети — при сборке полевого пакета (#2095). До этого
 * зоны попадали в телефон, только если человек успел открыть карту онлайн;
 * собрав пакет «в поле», он уходил без медвежьих зон и вулканов в кеше.
 * Исход назван: 'ok' — кеш обновлён, 'empty' — сервер ответил без зон
 * (кеш не трогаем: пустое не затирает старое), 'failed' — не дошли.
 */
export async function refreshGeofenceZones(): Promise<'ok' | 'empty' | 'failed'> {
  try {
    const r = await fetch('/api/safety/geofence-zones');
    const j = await r.json() as { success?: boolean; zones?: GeofenceZone[] };
    if (!j.success || !Array.isArray(j.zones)) return 'failed';
    if (j.zones.length === 0) return 'empty';
    writeCachedZones(j.zones);
    return 'ok';
  } catch {
    return 'failed';
  }
}

interface GeofenceState {
  breach: GeofenceBreach | null;
  zonesLoaded: boolean;
  /** Возраст кеша зон в часах. null = зоны пришли напрямую из сети (свежие). */
  zonesAgeHours: number | null;
}

export interface GeofenceZonesState {
  zones: GeofenceZone[];
  zonesLoaded: boolean;
  /** Возраст кеша зон в часах. null = зоны пришли напрямую из сети (свежие). */
  zonesAgeHours: number | null;
}

/** Позиция для проверки близости — из любого источника GPS экрана. */
export interface GeofencePosition {
  lat: number;
  lng: number;
  /** Точность в метрах; null — неизвестна, такой фикс не судит (гейт 300 м). */
  accuracy: number | null;
  /** Время фикса, мс. */
  timestamp: number;
}

/**
 * Зоны опасности: кеш любого возраста, сеть — оппортунистически.
 * Принцип: «старые зоны лучше пустых» — вулкан не переедет за 10 минут.
 * Отдельно от проверки близости (#2095): у экрана «На маршруте» свой
 * watchPosition, и второй наблюдатель GPS ради геофенса ему не нужен.
 */
export function useGeofenceZones(): GeofenceZonesState {
  const [zones, setZones]            = useState<GeofenceZone[]>([]);
  const [zonesLoaded, setLoaded]     = useState(false);
  const [zonesAgeHours, setAgeHours] = useState<number | null>(null);
  const fetchedRef                   = useRef(false);

  useEffect(() => {
    const cached = readCachedZones();
    if (cached) {
      setZones(cached.zones);
      setLoaded(true);
      setAgeHours(cached.ageMs / 3_600_000);
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
          setAgeHours(null); // свежие из сети
          writeCachedZones(j.zones);
        }
      })
      .catch(() => { /* офлайн — продолжаем с тем, что есть в кеше */ });
  }, []);

  return { zones, zonesLoaded, zonesAgeHours };
}

/**
 * Проверка бреча. Три гейта против ложной тревоги:
 *  1) точность хуже 300м (или неизвестна) — вышка сотовой, не GPS;
 *  2) позиция старше 3 мин — устаревший кеш (юзер уже не там), НЕ живой алерт;
 *  3) нет зон/позиции.
 * Интервал переоценивает и СБРАСЫВАЕТ алерт, когда позиция протухает
 * (GPS пропал в поле) — иначе «вы приближаетесь, 0.7 км» висело бы навсегда.
 */
export function useGeofenceBreach(position: GeofencePosition | null, zones: GeofenceZone[]): GeofenceBreach | null {
  const [breach, setBreach] = useState<GeofenceBreach | null>(null);
  const lat = position?.lat;
  const lng = position?.lng;
  const accuracy = position?.accuracy ?? null;
  const timestamp = position?.timestamp;

  useEffect(() => {
    const evaluate = () => {
      if (
        lat == null || lng == null || timestamp == null ||
        !zones.length ||
        accuracy == null || accuracy > 300 ||
        !isPositionFreshForGeofence(timestamp)
      ) {
        setBreach(null);
        return;
      }
      setBreach(checkBreach(lat, lng, accuracy, zones));
    };
    evaluate();
    const ticker = setInterval(evaluate, 30_000);
    return () => clearInterval(ticker);
  }, [lat, lng, accuracy, timestamp, zones]);

  return breach;
}

/**
 * Следит за GPS-позицией через useOfflineGPS и проверяет попадание в опасные зоны.
 * Зоны кешируются в localStorage для работы без интернета.
 */
export function useGeofence(): GeofenceState {
  const { lastPosition } = useOfflineGPS();
  const { zones, zonesLoaded, zonesAgeHours } = useGeofenceZones();
  const breach = useGeofenceBreach(
    lastPosition
      ? { lat: lastPosition.lat, lng: lastPosition.lng, accuracy: lastPosition.accuracy, timestamp: lastPosition.timestamp }
      : null,
    zones,
  );
  return { breach, zonesLoaded, zonesAgeHours };
}
