'use client';
/**
 * Толчки за последние сутки для /map (владелец 02.10: «не все толчки попадают
 * на карту, нужно показывать за последние сутки»). Источник — тот же приём
 * сейсмики, что у радара (external_alerts), режим окна `?hours=24`.
 *
 * Три исхода, не два (§4.0): `loading`, `ok` (в том числе ноль толчков) и
 * `failed` — «не прочитали» не выдаётся за «толчков не было».
 */
import { useEffect, useState } from 'react';
import type { VedarMapQuake } from '@/components/shared/VedarMap';

export const MAP_QUAKE_HOURS = 24;
/** Рой афтершоков идёт минутами — карта перечитывает ленту раз в 5 мин. */
const REFRESH_MS = 5 * 60_000;

export type MapQuakesState = 'loading' | 'ok' | 'failed';

function isQuake(v: unknown): v is VedarMapQuake {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.lat === 'number' && typeof o.lng === 'number'
    && typeof o.magnitude === 'number' && typeof o.time === 'number';
}

export function useMapQuakes(): { quakes: VedarMapQuake[]; state: MapQuakesState } {
  const [quakes, setQuakes] = useState<VedarMapQuake[]>([]);
  const [state, setState] = useState<MapQuakesState>('loading');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/safety/seismic?hours=${MAP_QUAKE_HOURS}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: unknown = await res.json();
        const list = (body as { events?: unknown }).events;
        if (!Array.isArray(list)) throw new Error('ответ без events');
        if (!alive) return;
        setQuakes(list.filter(isQuake).map(q => ({ ...q, depth: typeof q.depth === 'number' ? q.depth : null })));
        setState('ok');
      } catch (err) {
        console.error('[map] толчки за сутки не прочитаны', err);
        // Прежний набор не стирается: лучше вчерашняя картина с пометкой,
        // чем пустая карта, которая читается как «тихо».
        if (alive) setState('failed');
      }
    };
    void load();
    const t = setInterval(() => { void load(); }, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { quakes, state };
}
