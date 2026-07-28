'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Первичный счётчик платформы. Пишет не только факт захода, но и поведение:
 * откуда пришли ВНУТРИ сайта (from_path), сколько пробыли на странице (dwell)
 * и в каком визите это было (sessionId).
 *
 * sessionId — случайный, лежит в sessionStorage и умирает вместе с вкладкой.
 * Он нужен, чтобы выстроить переходы одного визита по порядку, и ни с
 * личностью, ни с аккаунтом не связан: длинного профиля посетителя платформа
 * не строит намеренно (152-ФЗ).
 */

const SESSION_KEY = 'vedar_sid';

function sessionId(): string | undefined {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const fresh = (crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(36).slice(2)}`)
      .replace(/-/g, '')
      .slice(0, 32);
    sessionStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    // Приватный режим или заблокированное хранилище: визит останется
    // безымянным. Просмотр важнее, чем связка переходов.
    return undefined;
  }
}

/**
 * Доклад времени на странице. sendBeacon переживает закрытие вкладки, обычный
 * fetch — нет; keepalive-fetch остаётся запасным путём для старых браузеров.
 */
function beaconDwell(id: string, ms: number): void {
  const payload = JSON.stringify({ id, ms: Math.round(ms) });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/analytics/dwell', new Blob([payload], { type: 'application/json' }));
      return;
    }
  } catch { /* падаем в fetch ниже */ }
  fetch('/api/analytics/dwell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => { /* некритично */ });
}

export default function PageViewTracker() {
  const pathname = usePathname();
  const lastPath = useRef<string>('');
  /** id строки текущего просмотра — по нему дописывается время на странице. */
  const viewId = useRef<string | null>(null);
  /** Момент, с которого страница видима; null — вкладка скрыта. */
  const shownAt = useRef<number | null>(null);
  /** Накопленное видимое время: вкладку могут свернуть и вернуть. */
  const visibleMs = useRef(0);

  /** Досказать время текущего просмотра. Один просмотр — один доклад. */
  const flushDwell = useRef(() => {
    const id = viewId.current;
    if (!id) return;
    const total = visibleMs.current + (shownAt.current ? Date.now() - shownAt.current : 0);
    if (total <= 0) return;
    beaconDwell(id, total);
  });

  useEffect(() => {
    if (!pathname || pathname === lastPath.current) return;
    const prevPath = lastPath.current || undefined;
    lastPath.current = pathname;

    // Уходя со страницы — досказать её время, пока строка ещё известна.
    flushDwell.current();

    viewId.current = null;
    visibleMs.current = 0;
    shownAt.current = Date.now();

    fetch('/api/analytics/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: pathname,
        referrer: document.referrer || undefined,
        sessionId: sessionId(),
        fromPath: prevPath,
        // Next рендерит not-found.tsx, не меняя адрес: страницу опознаём по
        // маркеру, который она сама ставит (см. app/not-found.tsx).
        notFound: document.documentElement.dataset.notFound === '1' || undefined,
      }),
    })
      .then(r => r.json())
      .then((j: { id?: string | null }) => { viewId.current = j?.id ?? null; })
      .catch(() => { /* некритично */ });
  }, [pathname]);

  // Время считаем только пока страница видима: свёрнутая вкладка — не чтение.
  useEffect(() => {
    const flush = () => flushDwell.current();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (shownAt.current) {
          visibleMs.current += Date.now() - shownAt.current;
          shownAt.current = null;
        }
        flush();
      } else if (!shownAt.current) {
        shownAt.current = Date.now();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  return null;
}
