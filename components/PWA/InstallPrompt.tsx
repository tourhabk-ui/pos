'use client';

import { useState, useEffect } from 'react';

/** BeforeInstallPromptEvent is not in standard lib.dom.d.ts */
interface BeforeInstallPromptEvent extends Event {
  prompt(): void;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    // Не показывать если пользователь уже отклонил (14 дней)
    const wasDismissed = localStorage.getItem('pwa-install-dismissed');
    if (wasDismissed) {
      const dismissedAt = parseInt(wasDismissed, 10);
      if (Date.now() - dismissedAt < 14 * 24 * 60 * 60 * 1000) {
        return;
      }
    }
    setHidden(false);

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      // Показать через 30 секунд чтобы не раздражать сразу
      setTimeout(() => setShow(true), 30000);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setShow(false);
      setDeferredPrompt(null);
    }
  };

  const handleDismiss = () => {
    localStorage.setItem('pwa-install-dismissed', Date.now().toString());
    setShow(false);
  };

  // Не показывать если: скрыт, не ready, или нет deferredPrompt
  if (hidden || !show || !deferredPrompt) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 bg-[var(--bg-card)] shadow-lg rounded-lg p-4 z-50 border border-[var(--border)]">
      <div className="flex items-start gap-3">
        {/* Иконка — SVG placeholder, будет заменена на PWA иконку */}
        <img
          src="/icons/icon-192.png"
          alt="Ведар"
          className="w-12 h-12 rounded-xl shrink-0"
        />
        <div className="flex-1">
          <h3 className="font-medium text-[var(--text-primary)]">Знай куда идёшь — офлайн</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Маршруты, карта и SOS работают без интернета. Важно на Камчатке.
          </p>
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleInstall}
              className="px-4 py-2 bg-[var(--accent)] text-[var(--bg-primary)] rounded-full text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Установить
            </button>
            <button
              onClick={handleDismiss}
              className="px-4 py-2 text-[var(--text-secondary)] text-sm hover:text-[var(--text-primary)] transition-colors"
            >
              Позже
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
