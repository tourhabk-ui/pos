'use client';

import { useState, useEffect } from 'react';
import { Navigation, Bookmark, Share2, CloudSun } from 'lucide-react';

interface Props {
  lat: number;
  lng: number;
  placeId: string;
  name: string;
}

const LS_KEY = 'wishlist_places';

function getWishlist(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as string[]; }
  catch { return []; }
}

export function PlaceActionBar({ lat, lng, placeId, name }: Props) {
  const [bookmarked, setBookmarked] = useState(false);
  const [tempText, setTempText] = useState<string | null>(null);
  const [weather, setWeather] = useState<{ temp: number; icon: string } | null>(null);

  useEffect(() => {
    setBookmarked(getWishlist().includes(placeId));
  }, [placeId]);

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

  function toggleBookmark() {
    const list = getWishlist();
    let next: string[];
    if (list.includes(placeId)) {
      next = list.filter(id => id !== placeId);
      setBookmarked(false);
    } else {
      next = [...list, placeId];
      setBookmarked(true);
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  function handleShare() {
    if (navigator.share) {
      navigator.share({ title: name, url: window.location.href }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(window.location.href).then(() => {
        setTempText('Скопировано');
        setTimeout(() => setTempText(null), 2000);
      });
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
          onClick={toggleBookmark}
          aria-label={bookmarked ? 'Убрать из избранного' : 'Добавить в избранное'}
          className="p-2.5 rounded-xl border transition-colors"
          style={{
            background: bookmarked ? 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))' : 'var(--bg-hover)',
            borderColor: bookmarked ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--border)',
            color: bookmarked ? 'var(--accent)' : 'var(--text-secondary)',
          }}
        >
          <Bookmark className="w-4 h-4" fill={bookmarked ? 'currentColor' : 'none'} />
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
