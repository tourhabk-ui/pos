'use client';

import { useEffect } from 'react';
import { installSOSFlush } from '@/lib/offline/pending-queue';
import { reportSwRegistration } from '@/lib/offline/sw-status';
import { isWidgetPath } from '@/lib/embed/widget-frame';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    // Виджет в iframe на сайте партнёра: service worker Ведара ставился
    // каждому посетителю партнёра (кэш ~1,8 МБ) без визита на Ведар. Офлайн-
    // контур и дослыв SOS там не нужны — это форма заявки и чат.
    if (isWidgetPath(window.location.pathname)) return;
    // Судьба регистрации попадает в sw-status: раньше отказ глотался
    // `.catch(() => {})`, и офлайн-контур молча не существовал — карта «не
    // сохранялась» без объяснения. Продукт от ошибки не падает, но полевой
    // экран теперь может сказать словами, что офлайн недоступен.
    if ('serviceWorker' in navigator) {
      reportSwRegistration('registering');
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then(() => reportSwRegistration('ready'))
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          reportSwRegistration('failed', detail);
          console.error('Service Worker не зарегистрировался:', detail);
        });
    } else {
      reportSwRegistration('unsupported');
    }
    // Дослыв офлайн-очереди SOS для браузеров без Background Sync (iOS Safari):
    // при возврате сети и на старте. На Chromium дублирует SW-путь — сервер
    // отвечает 429 (уже принято), лишний дубль SOS безопаснее потери сигнала.
    installSOSFlush();
  }, []);

  return null;
}
