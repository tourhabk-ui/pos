'use client';

import { useState, useEffect } from 'react';
import { Navigation, Bookmark, Share2, CloudSun } from 'lucide-react';
import { useWishlist } from '@/hooks/use-wishlist';
import { shareLink, shareOutcomeMessage } from '@/lib/share';

interface Props {
  lat: number;
  lng: number;
  placeId: string;
  name: string;
}

export function PlaceActionBar({ lat, lng, placeId, name }: Props) {
  // Раньше отметка жила только в localStorage этого устройства: в личный
  // кабинет она не попадала и на втором устройстве исчезала — снаружи это
  // «избранное не работает» (владелец 09.08). Теперь тот же контракт, что у
  // витрины, с локальным зеркалом на случай офлайна.
  const fav = useWishlist('place', placeId);
  const [tempText, setTempText] = useState<string | null>(null);
  const [weather, setWeather] = useState<{ temp: number; icon: string } | null>(null);

  useEffect(() => {
    fetch(`/api/weather?lat=${lat}&lng=${lng}`)
      .then(r => r.json())
      .then((d: unknown) => {
        if (typeof d !== 'object' || d === null) return;
        const rec = d as Record<string, unknown>;
        if (typeof rec.temperature === 'number') {
          setWeather({
            temp: Math.round(rec.temperature as number),
            icon: typeof rec.iconUrl === 'string' ? rec.iconUrl : '',
          });
        }
      })
      .catch(() => {});
  }, [lat, lng]);

  // Единственная из четырёх копий, где фолбэк и подтверждение были сделаны
  // верно. Поведение сохранено, реализация — общая.
  async function handleShare() {
    const outcome = await shareLink({ title: name, url: window.location.href });
    const message = shareOutcomeMessage(outcome);
    if (message) {
      setTempText(message);
      setTimeout(() => setTempText(null), 2500);
    }
  }

  const geoUrl = `geo:${lat},${lng}?q=${encodeURIComponent(name)}`;

  return (
    <div className="sticky z-30 bg-[var(--bg-card)] border-b border-[var(--border)]" style={{ top: '56px' }}>
      <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-2">
        <a
          href={geoUrl}
          className="flex-1 flex items-center justify-center gap-2 text-sm font-semibold py-2.5 rounded-xl text-white transition-opacity hover:opacity-90"
          style={{ background: 'var(--accent)' }}
        >
          <Navigation className="w-4 h-4" />
          Навигация
        </a>

        <button
          onClick={fav.toggle}
          aria-label={fav.on ? 'Убрать из избранного' : 'Добавить в избранное'}
          className="p-2.5 rounded-xl border transition-colors"
          style={{
            background: fav.on ? 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))' : 'var(--bg-hover)',
            borderColor: fav.on ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--border)',
            color: fav.on ? 'var(--accent)' : 'var(--text-secondary)',
          }}
        >
          <Bookmark className="w-4 h-4" fill={fav.on ? 'currentColor' : 'none'} />
        </button>

        <button
          onClick={handleShare}
          aria-label="Поделиться"
          className="p-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)]"
        >
          {tempText
            ? <span className="text-[10px] font-bold text-[var(--success)] px-0.5">{tempText}</span>
            : <Share2 className="w-4 h-4" />
          }
        </button>

        {weather && (
          <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-hover)]">
            {weather.icon
              ? <img src={weather.icon} alt="" className="w-5 h-5" />
              : <CloudSun className="w-4 h-4 text-[var(--ocean)]" />
            }
            <span className="text-sm font-semibold text-[var(--text-primary)]">{weather.temp}°</span>
          </div>
        )}
      </div>
    </div>
  );
}
