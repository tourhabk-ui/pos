'use client';

import { useEffect } from 'react';
import { geolocationOnce } from '@/lib/geo/current-position';

export const LAST_ONLINE_POS_KEY = 'vedar_last_online_pos';

export function LastPositionTracker() {
  useEffect(() => {
    const found = geolocationOnce();
    if (!found || !navigator.permissions) return;
    const geo: NonNullable<typeof found> = found;

    let timer: ReturnType<typeof setInterval> | null = null;

    async function saveIfOnline() {
      if (!navigator.onLine) return;
      try {
        const perm = await navigator.permissions.query({ name: 'geolocation' });
        if (perm.state !== 'granted') return;
      } catch {
        return;
      }

      geo.getCurrentPosition(
        (pos) => {
          try {
            localStorage.setItem(LAST_ONLINE_POS_KEY, JSON.stringify({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              acc: Math.round(pos.coords.accuracy),
              t: Date.now(),
            }));
          } catch {/* storage full or unavailable */}
        },
        () => {/* silent — don't annoy user with GPS errors on normal pages */},
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 },
      );
    }

    void saveIfOnline();
    timer = setInterval(() => { void saveIfOnline(); }, 3 * 60 * 1000);

    return () => { if (timer) clearInterval(timer); };
  }, []);

  return null;
}
