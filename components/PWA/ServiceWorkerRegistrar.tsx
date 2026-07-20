'use client';

import { useEffect } from 'react';
import { installSOSFlush } from '@/lib/offline/pending-queue';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch(() => {});
    }
    // Дослыв офлайн-очереди SOS для браузеров без Background Sync (iOS Safari):
    // при возврате сети и на старте. На Chromium дублирует SW-путь — сервер
    // отвечает 429 (уже принято), лишний дубль SOS безопаснее потери сигнала.
    installSOSFlush();
  }, []);

  return null;
}
