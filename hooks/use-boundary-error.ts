'use client';

/**
 * Общая часть каждой границы ошибок (все error.tsx под app/ и корневая
 * app/global-error.tsx): доклад в ловушку и «страница не догрузилась».
 *
 * До 07.11 докладывали только две границы — app/error.tsx и корневая.
 * Одиннадцать границ разделов (кабинеты, карточка тура, маршрут, карта)
 * ловили ошибку молча: пойманная границей ошибка до window.onerror не
 * доходит, и ловушка её не видела (§4.0: «отказ не глушится»). Теперь
 * докладывает каждая — тем же родом boundary.
 *
 * Ошибка загрузки куска кода — не дефект страницы, а связь или выкладка:
 * граница один раз перезагружает страницу сама (правило — в
 * lib/client-errors/chunk-load.ts), а экран говорит, что случилось.
 */
import { useEffect, useState } from 'react';
import { reportClientError } from '@/lib/client-errors/report';
import {
  CHUNK_RELOAD_STALL_MS,
  browserPage,
  decideChunkReload,
  isChunkLoadError,
  sessionStorageOrNull,
  type ChunkReloadDecision,
} from '@/lib/client-errors/chunk-load';

export interface BoundaryErrorState {
  /** Ошибка — не догрузившийся кусок кода: экран показывает своё, а не текст раздела. */
  chunk: boolean;
  /** Исход решения о перезагрузке; null — ещё не принято или ошибка не та. */
  decision: ChunkReloadDecision | null;
}

export function useBoundaryError(error: unknown): BoundaryErrorState {
  const chunk = isChunkLoadError(error);
  const [decision, setDecision] = useState<ChunkReloadDecision | null>(null);

  useEffect(() => {
    // Доклад раньше перезагрузки: sendBeacon переживает уход со страницы.
    reportClientError('boundary', error);
    if (!chunk) return;
    const next = decideChunkReload({
      path: window.location.pathname,
      now: Date.now(),
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
      storage: sessionStorageOrNull(),
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- исход читает браузер (sessionStorage, сеть, адрес), до монтирования его нет
    setDecision(next);
    if (next !== 'reload') return;
    browserPage.reload();
    const stall = setTimeout(() => setDecision('already-tried'), CHUNK_RELOAD_STALL_MS);
    return () => clearTimeout(stall);
  }, [error, chunk]);

  return { chunk, decision };
}
