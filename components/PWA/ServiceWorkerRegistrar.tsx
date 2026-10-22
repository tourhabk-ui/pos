'use client';

import { useEffect } from 'react';
import { installSOSFlush } from '@/lib/offline/pending-queue';
import { installFieldQueuesFlush } from '@/lib/offline/field-queues';
import { reportSwRegistration } from '@/lib/offline/sw-status';
import { isForeignSurface } from '@/lib/embed/widget-frame';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    // Виджет в iframe на сайте партнёра: service worker Ведара ставился
    // каждому посетителю партнёра (кэш ~1,8 МБ) без визита на Ведар. Офлайн-
    // контур и дослыв SOS там не нужны — это форма заявки и чат.
    if (isForeignSurface(window.location.pathname)) return;
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
    // Тот же досыл для полевых очередей — наблюдений и полевых проверок
    // (#2448): до 14.10 они уходили только при открытом экране, и открытое со
    // связью приложение очередь лишь считало.
    installFieldQueuesFlush();
  }, []);

  return null;
}
