'use client';

/**
 * Локальное хранение плана подготовки (anonymous-first, план FCN этап 4).
 *
 * План живёт на устройстве: подготовка не должна требовать регистрации.
 * Серверное хранение (таблицы миграции 864) подключается на этапе 5 вместе
 * с шарингом группе — там оно впервые получает смысл.
 */

import type { PrepAnswers, PrepState, PreparationPlan } from './types';

const keyFor = (routeId: string) => `trip_prep_${routeId}`;

export function loadPreparationPlan(routeId: string): PreparationPlan | null {
  try {
    const raw = localStorage.getItem(keyFor(routeId));
    if (!raw) return null;
    const p = JSON.parse(raw) as PreparationPlan;
    if (!p || typeof p !== 'object' || p.routeId !== routeId) return null;
    return {
      routeId,
      routeVersion: typeof p.routeVersion === 'number' ? p.routeVersion : 1,
      answers: (p.answers ?? {}) as PrepAnswers,
      userStates: (p.userStates ?? {}) as Record<string, PrepState>,
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function savePreparationPlan(plan: PreparationPlan): void {
  try {
    localStorage.setItem(keyFor(plan.routeId), JSON.stringify(plan));
  } catch { /* квота/приватный режим — план живёт в памяти сессии */ }
}
