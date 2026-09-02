'use client';

/**
 * hooks/useDocumentTheme.ts — тема страницы как её видит документ.
 *
 * Корневой скрипт в layout ставит `data-theme` на <html> из localStorage
 * (`kh-theme`) до первого рендера; переключатель в шапке меняет атрибут.
 * Своя карта (MapLibre) считает цвета в WebGL и до CSS-каскада не достаёт —
 * ей тему надо ПЕРЕДАТЬ. Первый живой рендер 02.09: интерфейс светлый, а
 * карта под ним принудительно тёмная — две палитры одного экрана.
 *
 * Наблюдатель за атрибутом, а не чтение один раз: переключение темы на ходу
 * иначе оставляло бы карту в прежней.
 */
import { useEffect, useState } from 'react';

export type DocumentTheme = 'light' | 'dark';

function readTheme(): DocumentTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function useDocumentTheme(): DocumentTheme {
  // До монтирования — 'dark': это тема полевого контура по умолчанию, и
  // сервер с клиентом рендерят одно и то же, без расхождения гидратации.
  const [theme, setTheme] = useState<DocumentTheme>('dark');
  useEffect(() => {
    setTheme(readTheme());
    const obs = new MutationObserver(() => setTheme(readTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}
