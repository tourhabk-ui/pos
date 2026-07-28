'use client';

import { useEffect, useLayoutEffect } from 'react';

/**
 * Помечает страницу как 404 для счётчика. Next рендерит not-found.tsx, НЕ меняя
 * адрес в строке браузера, поэтому по пути отличить «страница не найдена» от
 * обычного просмотра нельзя — а отличать надо: 404 в топе страниц означает
 * битую ссылку у нас или в чужой выдаче, то есть ошибку, а не интерес.
 *
 * Метка ставится в layout-эффекте намеренно: React выполняет их до passive-
 * эффектов того же коммита, а PageViewTracker шлёт событие именно из passive.
 * Так метка гарантированно уже стоит к моменту отправки, а при уходе со
 * страницы снимается раньше, чем уйдёт событие следующего просмотра.
 */
const useMarkerEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export default function NotFoundMarker() {
  useMarkerEffect(() => {
    document.documentElement.dataset.notFound = '1';
    return () => { delete document.documentElement.dataset.notFound; };
  }, []);

  return null;
}
