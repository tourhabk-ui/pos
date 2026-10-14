'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Потолок ожидания простоя для карты обзора /map. Дольше двух секунд экран без
 * карты — уже «карта не грузится», а не «сначала нарисовалось остальное».
 */
export const MAP_IDLE_MAX_WAIT_MS = 2_000;

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/**
 * true — когда браузер освободился после первой отрисовки, но не позже
 * maxWaitMs. Где requestIdleCallback нет (Safari), — после кадра отрисовки.
 */
export function useIdleStart(maxWaitMs: number): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let done = false;
    const start = () => {
      if (done) return;
      done = true;
      setReady(true);
    };
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(start, { timeout: maxWaitMs });
      return () => {
        done = true;
        w.cancelIdleCallback?.(id);
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => { timer = setTimeout(start, 0); });
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [maxWaitMs]);
  return ready;
}

/**
 * Тяжёлое — после того, как нарисовалось остальное (14.10).
 *
 * Прогоны 9–12 переписи (Lighthouse, мобильный профиль): на /map больше трети
 * работы главного потока — сборка шейдеров и подготовка WebGL в MapLibre, и
 * на это время вставала отрисовка всего прочего: шапка, чипы и окно согласия
 * ждали карту 2,9–5,7 с («задержка отрисовки» LCP). Здесь карта монтируется,
 * когда браузер освободился, — не позже потолка. Касания не нужно: на
 * странице карты её ждут сразу, просто не раньше остального.
 *
 * Полевой экран так не делает и не должен: там карта — прибор
 * (сторож tests/unit/idle-mount.test.tsx).
 */
export function IdleMount({ children, placeholder, maxWaitMs = MAP_IDLE_MAX_WAIT_MS }: {
  children: ReactNode;
  placeholder: ReactNode;
  maxWaitMs?: number;
}) {
  const ready = useIdleStart(maxWaitMs);
  return <>{ready ? children : placeholder}</>;
}
