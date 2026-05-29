'use client';

import { useEffect, useState } from 'react';
import { Navigation, Bookmark, Share2 } from 'lucide-react';

interface Props {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
}

interface WeatherData {
  temp: number;
  icon: string;
}

export default function PlaceActionBar({ placeId, name, lat, lng }: Props) {
  const [saved, setSaved] = useState(false);
  const [weather, setWeather] = useState<WeatherData | null>(null);

  useEffect(() => {
    try {
      const list = JSON.parse(localStorage.getItem('wishlist_places') ?? '[]') as string[];
      setSaved(list.includes(placeId));
    } catch { /* */ }

    fetch(`/api/weather?lat=${lat}&lng=${lng}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data) {
          const w = d.data;
          setWeather({
            temp: Math.round(w.temperature ?? w.temp ?? 0),
            icon: w.icon ?? '',
          });
        }
      })
      .catch(() => {});
  }, [placeId, lat, lng]);

  function toggleSave() {
    try {
      const list = JSON.parse(localStorage.getItem('wishlist_places') ?? '[]') as string[];
      const next = saved ? list.filter(x => x !== placeId) : [...list, placeId];
      localStorage.setItem('wishlist_places', JSON.stringify(next));
      setSaved(!saved);
    } catch { /* */ }
  }

  function handleShare() {
    const url = window.location.href;
    if (navigator.share) {
      navigator.share({ title: name, url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(url).catch(() => {});
    }
  }

  const geoUrl = `geo:${lat},${lng}?q=${encodeURIComponent(name)}`;

  return (
    <div className="sticky top-[3.5rem] z-[300] bg-[var(--bg-card)] border-b border-[var(--border)] px-4 py-2.5">
      <div className="max-w-3xl mx-auto flex items-center gap-2">
        <a
          href={geoUrl}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-white bg-[var(--accent)] hover:opacity-90 transition-opacity"
        >
          <Navigation className="w-4 h-4" />
          Навигация
        </a>

        <button
          onClick={toggleSave}
          aria-label={saved ? 'Убрать из сохранённых' : 'Сохранить'}
          className={`p-2 rounded-lg border transition-colors ${
            saved
              ? 'text-[var(--accent)] border-[var(--accent)] bg-[var(--accent)]/10'
              : 'text-[var(--text-muted)] border-[var(--border)] hover:bg-[var(--bg-hover)]'
          }`}
        >
          <Bookmark className={`w-4 h-4 ${saved ? 'fill-current' : ''}`} />
        </button>

        <button
          onClick={handleShare}
          aria-label="Поделиться"
          className="p-2 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <Share2 className="w-4 h-4" />
        </button>

        {weather && (
          <div className="flex items-center gap-1 pl-1 border-l border-[var(--border)] ml-1">
            {weather.icon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`https://openweathermap.org/img/wn/${weather.icon}.png`}
                alt=""
                width={24}
                height={24}
              />
            )}
            <span className="text-sm font-medium text-[var(--text-secondary)]">{weather.temp}°</span>
          </div>
        )}
      </div>
    </div>
  );
}
