'use client';

/**
 * MobileDashboardHeader — компактный статус-бар мобильного Field OS дашборда.
 * Заменяет стандартный Header на главной для мобильных (< md). Плавает поверх
 * hero-фото (absolute), glass-pill справа.
 *
 * Glassmorphism — осознанное решение владельца (2026-07-03), запрет снят,
 * см. CLAUDE.md §2: разрешён поверх фото и тёмных подложек.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wind, Cloud } from 'lucide-react';
import Logo from '@/components/shared/Logo';
import { useGeo } from '@/contexts/GeoContext';

interface WeatherChip {
  tempC: string;
  windKmph: string;
}

export function MobileDashboardHeader() {
  const { mode } = useGeo();
  const [online, setOnline] = useState(true);
  const [weather, setWeather] = useState<WeatherChip | null>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/safety/weather')
      .then(res => (res.ok ? res.json() : null))
      .then((data: { tempC?: string; windKmph?: string } | null) => {
        if (cancelled || !data?.tempC) return;
        setWeather({ tempC: data.tempC, windKmph: data.windKmph ?? '' });
      })
      .catch(() => { /* чип погоды просто не показываем */ });
    return () => { cancelled = true; };
  }, []);

  const statusLabel = mode === 'on-site' ? 'На месте' : online ? 'Online' : 'Офлайн';
  const statusColor = online ? 'var(--success)' : 'var(--text-muted)';
  const tempSign = weather && parseInt(weather.tempC) > 0 ? '+' : '';

  return (
    <header className="absolute inset-x-0 top-0 z-40 flex items-start justify-between px-4 py-3">
      <Link href="/" className="flex flex-col" aria-label="Ведар — на главную">
        <span className="flex items-center gap-2">
          <Logo size={22} className="text-[var(--success)]" />
          <span className="font-playfair text-lg font-bold text-white">Vedar</span>
        </span>
        <span className="text-[9px] uppercase tracking-[0.2em] text-white/60">
          Камчатка · дикая территория
        </span>
      </Link>

      <div className="flex items-center gap-3 rounded-full border border-white/15 backdrop-blur-md bg-black/40 px-3 py-1 text-xs text-white">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: statusColor }}
          />
          {statusLabel}
        </span>
        {weather && (
          <>
            <span className="h-3 w-px bg-white/20" aria-hidden />
            <span className="flex items-center gap-1">
              <Cloud size={13} strokeWidth={1.5} aria-hidden />
              {tempSign}{weather.tempC}°C
            </span>
            {weather.windKmph && (
              <span className="flex items-center gap-1">
                <Wind size={13} strokeWidth={1.5} aria-hidden />
                {Math.round(parseInt(weather.windKmph) / 3.6)} м/с
              </span>
            )}
          </>
        )}
      </div>
    </header>
  );
}
