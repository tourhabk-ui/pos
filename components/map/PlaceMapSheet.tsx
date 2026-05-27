'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { X, Navigation, Bookmark, Share2, ArrowRight } from 'lucide-react';
import { LOCATION_TYPE_LABELS } from '@/components/places/types';
import type { PlaceRoute } from '@/components/places/types';

interface InitialData {
  title: string;
  locationType: string | null;
  lat: number;
  lng: number;
  description: string;
}

interface Props {
  placeId: string;
  initialData: InitialData;
  userPos: { lat: number; lng: number } | null;
  isOffline: boolean;
  onClose: () => void;
}

interface FullData {
  images: string[];
  routes: PlaceRoute[];
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} м`;
  return `${(meters / 1000).toFixed(1)} км`;
}

export default function PlaceMapSheet({ placeId, initialData, userPos, isOffline, onClose }: Props) {
  const [fullData, setFullData] = useState<FullData | null>(null);
  const [loadingFull, setLoadingFull] = useState(!isOffline);
  const [saved, setSaved] = useState(false);

  const { title, locationType, lat, lng } = initialData;
  const typeLabel = LOCATION_TYPE_LABELS[locationType ?? 'other'] ?? 'Место';
  const distance = userPos ? haversineDistance(userPos.lat, userPos.lng, lat, lng) : null;
  const distStr = distance !== null ? formatDistance(distance) : null;
  const geoUrl = `geo:${lat},${lng}?q=${encodeURIComponent(title)}`;

  useEffect(() => {
    try {
      const list = JSON.parse(localStorage.getItem('wishlist_places') ?? '[]') as string[];
      setSaved(list.includes(placeId));
    } catch { /* */ }

    if (isOffline) return;

    fetch(`/api/places/${placeId}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data) {
          setFullData({
            images: (d.data.images as unknown[]).filter((x): x is string => typeof x === 'string'),
            routes: (d.data.routes as PlaceRoute[]) ?? [],
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoadingFull(false));
  }, [placeId, isOffline]);

  function toggleSave() {
    try {
      const list = JSON.parse(localStorage.getItem('wishlist_places') ?? '[]') as string[];
      const next = saved ? list.filter(x => x !== placeId) : [...list, placeId];
      localStorage.setItem('wishlist_places', JSON.stringify(next));
      setSaved(!saved);
    } catch { /* */ }
  }

  function handleShare() {
    const url = `${window.location.origin}/places/${placeId}`;
    if (navigator.share) {
      navigator.share({ title, url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(url).catch(() => {});
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-[749]" onClick={onClose} />

      {/* Sheet */}
      <div
        className="fixed bottom-0 left-0 right-0 z-[750] bg-[var(--bg-card)] rounded-t-2xl shadow-2xl flex flex-col"

      {/* Sheet */}
      <div
        style={{ animation: 'slideUp 0.25s ease-out', maxHeight: '65vh' }}
      >
        {/* Pull handle */}
        <div className="flex justify-center pt-2 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-[var(--border)]" />
        </div>

        {/* Photo strip — online only */}
        {!isOffline && (
          <div
            className="flex gap-2 px-3 pb-2 shrink-0 overflow-x-auto"
            style={{ scrollbarWidth: 'none' }}
          >
            {loadingFull ? (
              [1, 2, 3].map(i => (
                <div key={i} className="flex-shrink-0 w-32 h-[112px] rounded-xl bg-[var(--bg-hover)] animate-pulse" />
              ))
            ) : fullData?.images && fullData.images.length > 0 ? (
              fullData.images.slice(0, 6).map((img, i) => (
                <Link
                  key={i}
                  href={`/places/${placeId}`}
                  className="flex-shrink-0 w-32 h-[112px] rounded-xl overflow-hidden relative"
                >
                  <Image
                    src={img}
                    alt={`${title} ${i + 1}`}
                    fill
                    className="object-cover"
                    sizes="128px"
                  />
                </Link>
              ))
            ) : null}
          </div>
        )}

        {/* Content */}
        <div className="px-4 pb-4 overflow-y-auto flex-1">
          {/* Header row */}
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold uppercase tracking-widest text-[var(--accent)] mb-0.5">
                {typeLabel}
              </p>
              <h3
                className="text-lg font-semibold text-[var(--text-primary)] leading-snug"
                style={{ fontFamily: 'var(--font-playfair)' }}
              >
                {title}
              </h3>
              {distStr && (
                <p className="text-sm text-[var(--text-muted)] mt-0.5">{distStr} от вас</p>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors shrink-0 mt-0.5"
              aria-label="Закрыть"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 mb-4">
            <a
              href={geoUrl}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium text-white bg-[var(--accent)] hover:opacity-90 transition-opacity"
            >
              <Navigation className="w-4 h-4" />
              Навигация
            </a>
            <button
              onClick={toggleSave}
              aria-label={saved ? 'Убрать из сохранённых' : 'Сохранить'}
              className={`p-2.5 rounded-lg border transition-colors ${
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
              className="p-2.5 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <Share2 className="w-4 h-4" />
            </button>
          </div>

          {/* Routes — online only */}
          {!isOffline && (
            <div className="mb-3">
              {loadingFull ? (
                <div className="flex gap-2">
                  {[1, 2].map(i => (
                    <div key={i} className="h-8 w-32 rounded-lg bg-[var(--bg-hover)] animate-pulse" />
                  ))}
                </div>
              ) : fullData?.routes && fullData.routes.length > 0 ? (
                <>
                  <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-2">
                    Маршруты через это место
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {fullData.routes.slice(0, 4).map(r => (
                      <Link
                        key={r.id}
                        href={`/routes/${r.id}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors"
                      >
                        <span className="line-clamp-1 max-w-[160px]">{r.title}</span>
                        <ArrowRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                      </Link>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          )}

          {/* Open full page */}
          <Link
            href={`/places/${placeId}`}
            className="flex items-center justify-center gap-1.5 w-full py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] rounded-lg hover:border-[var(--accent)] transition-colors"
          >
            Открыть подробнее
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </>
  );
}
