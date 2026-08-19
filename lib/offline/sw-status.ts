'use client';

/**
 * Судьба регистрации Service Worker — читаемое состояние, а не проглоченная
 * ошибка.
 *
 * До этого регистрация заканчивалась `.catch(() => {})`: если SW не поднялся,
 * офлайн-контур (карта, очередь SOS, прекэш экранов) молча переставал
 * существовать, а человек узнавал об этом уже в поле — по несохранившейся
 * карте, без объяснения. Для offline-first продукта «не запустился служебный
 * модуль» — это не деталь реализации, а факт готовности, о котором экран
 * обязан уметь сказать словами.
 *
 * Здесь нет попытки чинить регистрацию — только честная память о том, чем она
 * кончилась, и подписка для экранов, которым это важно (полевой режим).
 */

import { useSyncExternalStore } from 'react';

export type SwRegistrationState =
  /** Ещё не пробовали (SSR, до первого эффекта). */
  | 'unknown'
  /** Браузер не поддерживает Service Worker — офлайна не будет вовсе. */
  | 'unsupported'
  /** Регистрация запущена, результата пока нет. */
  | 'registering'
  /** SW зарегистрирован — офлайн-контур доступен. */
  | 'ready'
  /** Регистрация упала — офлайн-контур недоступен, и это надо говорить. */
  | 'failed';

export interface SwRegistrationInfo {
  state: SwRegistrationState;
  /** Текст ошибки при `failed` — для диагностики, не для показа туристу. */
  detail: string | null;
}

let info: SwRegistrationInfo = { state: 'unknown', detail: null };
const listeners = new Set<() => void>();

export function reportSwRegistration(state: SwRegistrationState, detail?: string): void {
  info = { state, detail: detail ?? null };
  listeners.forEach(fn => fn());
}

export function getSwRegistration(): SwRegistrationInfo {
  return info;
}

export function subscribeSwRegistration(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Реактивная подписка для клиентских компонентов. */
export function useSwRegistration(): SwRegistrationInfo {
  return useSyncExternalStore(subscribeSwRegistration, getSwRegistration, getSwRegistration);
}
