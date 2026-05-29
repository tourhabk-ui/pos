'use client';

import { WifiOff, MapPin, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { useOfflineGPS } from '@/hooks/useOfflineGPS';

export default function OfflineGPSBanner() {
  const { isOffline, lastPosition, minutesAgo } = useOfflineGPS();
  const [copied, setCopied] = useState(false);

  if (!isOffline) return null;

  function handleCopy() {
    if (!lastPosition) return;
    const coords = `${lastPosition.lat.toFixed(6)}, ${lastPosition.lng.toFixed(6)}`;
    navigator.clipboard?.writeText(coords).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="w-full px-4 py-2.5 flex items-start gap-3"
      style={{
        background: '#1A1714',
        color: 'var(--text-primary)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <WifiOff className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />

      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold" style={{ color: 'var(--warning)' }}>
          Нет подключения к сети
        </p>

        {lastPosition ? (
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <MapPin className="w-3 h-3 shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
            <span className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>
              {lastPosition.lat.toFixed(5)},&nbsp;{lastPosition.lng.toFixed(5)}
            </span>
            {lastPosition.accuracy <= 500 && (
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                ±{lastPosition.accuracy}м
              </span>
            )}
            {minutesAgo !== null && (
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                · {minutesAgo === 0 ? 'только что' : `${minutesAgo} мин. назад`}
              </span>
            )}
            <button
              onClick={handleCopy}
              aria-label="Скопировать координаты"
              className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors"
              style={{
                background: 'var(--border)',
                color: copied ? 'var(--success)' : 'var(--text-secondary)',
              }}
            >
              {copied
                ? <><Check className="w-3 h-3" aria-hidden="true" /> Скопировано</>
                : <><Copy className="w-3 h-3" aria-hidden="true" /> Копировать</>
              }
            </button>
          </div>
        ) : (
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            Местоположение ещё не определено — включите GPS
          </p>
        )}
      </div>
    </div>
  );
}
