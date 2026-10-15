'use client';

/**
 * Язык окна виджета партнёра по языку браузера посетителя (аудит 15.10,
 * WID-lang). Словарь и правило выбора — lib/embed/widget-i18n.
 *
 * Через useSyncExternalStore, а не useState(navigator…): страница рисуется и
 * на сервере, где языка браузера нет. Сервер отдаёт русский (снимок
 * сервера), браузер после гидрации — свой язык, без расхождения разметки.
 * Сменил человек язык браузера — окно переключится по `languagechange`.
 */
import { useSyncExternalStore } from 'react';
import { pickWidgetLang, type WidgetLang } from '@/lib/embed/widget-i18n';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('languagechange', onChange);
  return () => window.removeEventListener('languagechange', onChange);
}

function getSnapshot(): WidgetLang {
  return pickWidgetLang(navigator.language);
}

function getServerSnapshot(): WidgetLang {
  return 'ru';
}

export function useWidgetLang(): WidgetLang {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
