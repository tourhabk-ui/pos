'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { X, Navigation, Bookmark, Share2, ArrowRight, MapPin } from 'lucide-react';

interface InitialData {
  id: string;
  title: string;
  locationType: string | null;
  lat: number;
  lng: number;
  description: string;
}

interface RouteLink {
  id: string;
  title: string;
}

interface DetailData {
  photoUrl: string | null;
  routes: RouteLink[];
}

interface Props {
  initialData: InitialData;
  userPos: { lat: number; lng: number } | null;
  isOffline: boolean;
  onClose: () => void;
  distLabel: string | null;
}

const LOCATION_LABELS: Record<string, string> = {
  volcano: 'Вулкан', lake: 'Озеро', hot_spring: 'Источник', mountain: 'Гора',
  geyser: 'Гейзер', waterfall: 'Водопад', beach: 'Пляж', valley: 'Долина',
  river: 'Река', cave: 'Пещера', other: 'Место',
};

const LS_KEY = 'wishlist_places';
function isBookmarked(id: string) {
  try { return (JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as string[]).includes(id); }
  catch { return false; }
}
function toggleBookmark(id: string) {
  try {
    const list = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as string[];
    const next = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
    localStorage.setItem(LS_KEY, JSON.stringify(next));
    return !list.includes(id);
  } catch { return false; }
}

export function PlaceMapSheet({ initialData, userPos, isOffline, onClose, distLabel }: Props) {
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [bookmarked, setBookmarked] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);

  // Swipe-down to close
  function onTouchStart(e: React.TouchEvent) {
    dragStartY.current = e.touches[0].clientY;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (dragStartY.current === null) return;
    const delta = e.changedTouches[0].clientY - dragStartY.current;
    if (delta > 80) onClose();
    dragStartY.current = null;
  }

  useEffect(() => {
    setBookmarked(isBookmarked(initialData.id));
  }, [initialData.id]);

  // Fetch detail async (only online)
  useEffect(() => {
    if (isOffline) return;
    fetch(`/api/places/${initialData.id}`)
      .then(r => r.json())
      .then((d: unknown) => {
        if (typeof d !== 'object' || d === null) return;
        const body = (d as Record<string, unknown>).data as Record<string, unknown> | undefined;
        if (!body) return;
        const routes = Array.isArray(body.routes)
          ? (body.routes as Array<Record<string, unknown>>).slice(0, 3).map(r => ({
              id: r.id as string,
              title: r.title as string,
            }))
          : [];
        setDetail({
          photoUrl: body.photoUrl as string | null,
          routes,
        });
      })
      .catch(() => {});
  }, [initialData.id, isOffline]);

  const typeLabel = LOCATION_LABELS[initialData.locationType ?? 'other'] ?? 'Место';
  const geoUrl = `geo:${initialData.lat},${initialData.lng}?q=${encodeURIComponent(initialData.title)}`;

  function handleShare() {
    const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/places/${initialData.id}`;
    if (navigator.share) {
      navigator.share({ title: initialData.title, url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(url);
    }
  }

  function handleBookmark() {
    const next = toggleBookmark(initialData.id);
    setBookmarked(next);
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[498]" onClick={onClose} />

      {/* Sheet */}
      <div
        ref={sheetRef}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        className="fixed bottom-0 left-0 right-0 z-[499] rounded-t-2xl overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: '0 -8px 40px rgba(0,0,0,0.18)' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 rounded-full bg-[var(--border)]" />
        </div>
        {/* Photo strip */}
        <div className="relative h-40 bg-[var(--bg-hover)]">
          {detail?.photoUrl ? (
            <Image src={detail.photoUrl} alt={initialData.title} fill className="object-cover" sizes="100vw" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <MapPin className="w-8 h-8 text-[var(--text-muted)] opacity-40" />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
          {/* Type badge */}
          <span className="absolute top-3 left-3 text-[10px] font-bold uppercase tracking-widest text-white px-2.5 py-1 rounded-full"
            style={{ background: 'var(--accent)' }}>
            {typeLabel}
          </span>
          {/* Close */}
          <button onClick={onClose}
            className="absolute top-3 right-3 p-1.5 rounded-full"
            style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.2)' }}>
            <X className="w-4 h-4 text-white" />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-3">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-[var(--text-primary)] text-base leading-snug"
                style={{ fontFamily: 'var(--font-playfair)' }}>
                {initialData.title}
              </h3>
              {distLabel && (
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{distLabel} от вас</p>
              )}
            </div>
          </div>

          {/* Description */}
          {initialData.description && (
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-2 mb-3">
              {initialData.description.split('\n')[0]}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 mb-3">
            <a href={geoUrl}
              className="flex-1 flex items-center justify-center gap-2 text-sm font-semibold py-2.5 rounded-xl text-white transition-opacity hover:opacity-90"
              style={{ background: 'var(--accent)' }}>
              <Navigation className="w-4 h-4" /> Навигация
            </a>
            <button onClick={handleBookmark}
              aria-label={bookmarked ? 'Убрать из избранного' : 'Добавить в избранное'}
              className="p-2.5 rounded-xl border transition-colors"
              style={{
                background: bookmarked ? 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))' : 'var(--bg-hover)',
                borderColor: bookmarked ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--border)',
                color: bookmarked ? 'var(--accent)' : 'var(--text-secondary)',
              }}>
              <Bookmark className="w-4 h-4" fill={bookmarked ? 'currentColor' : 'none'} />
            </button>
            <button onClick={handleShare}
              aria-label="Поделиться"
              className="p-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors">
              <Share2 className="w-4 h-4" />
            </button>
          </div>

          {/* Routes through this place */}
          {(detail?.routes?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {detail!.routes.map(r => (
                <Link key={r.id} href={`/routes/${r.id}`}
                  className="text-xs font-medium px-3 py-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:border-[var(--ocean)] hover:text-[var(--ocean)] transition-colors">
                  {r.title}
                </Link>
              ))}
            </div>
          )}

          {/* Open details */}
          <Link href={`/places/${initialData.id}`}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-hover)] hover:bg-[var(--bg-card)] transition-colors mb-1">
            Открыть подробнее <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </>
  );
}
