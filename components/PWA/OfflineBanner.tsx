'use client';

/**
 * OfflineBanner — тонкая полоса «Офлайн — данные могут устареть» вверху экрана,
 * когда пропала сеть. Фидбэк с Халактырского пляжа: в поле важно понимать,
 * что приложение работает из кэша и часть данных не обновляется (а не «висит»).
 *
 * Ничего не выдумывает: показывается строго по navigator.onLine + online/offline
 * событиям. СОС и офлайн-карта продолжают работать — об этом и сообщаем.
 */

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 120,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: 'calc(4px + env(safe-area-inset-top)) 12px 4px',
        background: 'var(--warning)',
        color: '#1A1714',
        fontSize: '12px',
        fontWeight: 600,
        lineHeight: 1.3,
      }}
    >
      <WifiOff size={14} strokeWidth={2} aria-hidden />
      Офлайн — данные могут устареть. СОС и карта работают.
    </div>
  );
}

export default OfflineBanner;
