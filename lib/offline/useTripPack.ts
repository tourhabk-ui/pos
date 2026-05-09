'use client';

/**
 * useTripPack — скачивает и кэширует в IndexedDB полный офлайн-пакет маршрута.
 * Работает поверх /api/trip-plans/[id]/pack.
 */

import { useState, useCallback } from 'react';
import {
  saveTripPlan, getTripPlan, listTripPlans, deleteTripPlan,
  type OfflineTripPlan,
} from './db';

export type PackStatus = 'idle' | 'downloading' | 'cached' | 'error';

export interface TripPackState {
  status: PackStatus;
  error: string | null;
  plan: OfflineTripPlan | null;
}

export function useTripPack(planId: string | null) {
  const [state, setState] = useState<TripPackState>({
    status: 'idle',
    error: null,
    plan: null,
  });

  const checkCached = useCallback(async () => {
    if (!planId) return;
    const cached = await getTripPlan(planId);
    if (cached) {
      setState({ status: 'cached', error: null, plan: cached });
    }
  }, [planId]);

  const download = useCallback(async () => {
    if (!planId) return;
    setState(s => ({ ...s, status: 'downloading', error: null }));

    try {
      const res = await fetch(`/api/trip-plans/${planId}/pack`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { success: boolean; data: OfflineTripPlan; error?: string };
      if (!json.success) throw new Error(json.error ?? 'Ошибка загрузки пакета');

      await saveTripPlan(json.data);
      setState({ status: 'cached', error: null, plan: json.data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка сети';
      setState(s => ({ ...s, status: 'error', error: msg }));
    }
  }, [planId]);

  const remove = useCallback(async () => {
    if (!planId) return;
    await deleteTripPlan(planId);
    setState({ status: 'idle', error: null, plan: null });
  }, [planId]);

  return { ...state, checkCached, download, remove };
}

// ─── List all cached plans ────────────────────────────────────────────────────

export function useOfflineTripList() {
  const [plans, setPlans] = useState<OfflineTripPlan[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await listTripPlans();
      setPlans(all.sort((a, b) => b.cachedAt - a.cachedAt));
    } finally {
      setLoading(false);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteTripPlan(id);
    setPlans(prev => prev.filter(p => p.id !== id));
  }, []);

  return { plans, loading, load, remove };
}
