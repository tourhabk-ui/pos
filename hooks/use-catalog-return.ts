'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { catalogReturnHref } from '@/lib/routes/catalog-return';

const noopSubscribe = () => () => {};

/**
 * Адрес ссылки «назад в каталог» на карточке маршрута или места: тот список,
 * откуда турист пришёл (страница, фильтры), а не голый раздел.
 * На сервере и при гидрации — `fallback` (снимок сервера), в браузере —
 * сохранённый адрес, если он есть: useSyncExternalStore меняет значение
 * без лишнего рендера из эффекта и без расхождения разметки.
 */
export function useCatalogReturnHref(fallback: string): string {
  const getSnapshot = useCallback(() => catalogReturnHref(fallback), [fallback]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  return useSyncExternalStore(noopSubscribe, getSnapshot, getServerSnapshot);
}
