'use client';

import Image from 'next/image';
import { ArrowLeft, Copy, Check } from 'lucide-react';
import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { LOCATION_TYPE_LABELS } from './types';
import { RouteGradientPlaceholder } from '@/components/routes/RouteGradientPlaceholder';

interface Props {
  placeId: string;
  name: string;
  locationType: string | null;
  lat: number;
  lng: number;
  photoUrl: string | null;
  photoCount: number;
  images?: string[];
}

export default function PlaceHero({ placeId, name, locationType, lat, lng, photoUrl, photoCount, images }: Props) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const label = LOCATION_TYPE_LABELS[locationType ?? 'other'] ?? 'Место';
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  const coordStr = hasCoords ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : '';

  // Build gallery: prefer `images` array, fallback to single photoUrl
  const gallery: string[] = images && images.length > 0
    ? images
    : photoUrl ? [photoUrl] : [];

  const isGallery = gallery.length > 1;

  function copyCoords() {
    navigator.clipboard?.writeText(coordStr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleScroll() {
    if (!scrollRef.current) return;
    const idx = Math.round(scrollRef.current.scrollLeft / scrollRef.current.clientWidth);
    setActiveIndex(idx);
  }

  return (
    <div className="dark relative w-full overflow-hidden bg-[var(--bg-card)]" style={{ height: 'clamp(320px, 68vh, 720px)' }}>

      {/* Gallery or single photo */}
      {isGallery ? (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 flex overflow-x-auto"
          style={{ scrollSnapType: 'x mandatory', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
        >
          {gallery.map((src, i) => (
            <div key={i} className="relative flex-shrink-0 w-full h-full" style={{ scrollSnapAlign: 'start' }}>
              <Image src={src} alt={`${name} ${i + 1}`} fill className="object-cover" priority={i === 0} sizes="100vw" />
            </div>
          ))}
        </div>
      ) : gallery.length === 1 ? (
        <Image src={gallery[0]} alt={name} fill className="object-cover" priority sizes="100vw" />
      ) : (
        <RouteGradientPlaceholder title={name} locationType={locationType} className="w-full h-full" showLabel={false} />
      )}

      {/* Dark gradient for text contrast */}
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-primary)]/90 via-[var(--bg-primary)]/20 to-transparent pointer-events-none" />

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 pt-20 pb-4 z-20">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--text-primary)] bg-[var(--bg-card)]/60 px-3 py-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Назад
        </button>

        {/* Photo counter */}
        {isGallery && (
          <span className="text-xs text-[var(--text-primary)] bg-black/50 px-2.5 py-1.5 rounded-lg">
            {activeIndex + 1} / {gallery.length}
          </span>
        )}
      </div>

      {/* Dot indicators */}
      {isGallery && (
        <div className="absolute bottom-20 left-0 right-0 flex justify-center gap-1.5 z-20 pointer-events-none">
          {gallery.map((_, i) => (
            <div
              key={i}
              className="h-1.5 rounded-full transition-all duration-200"
              style={{
                width: i === activeIndex ? '20px' : '6px',
                background: i === activeIndex ? 'white' : 'rgba(255,255,255,0.45)',
              }}
            />
          ))}
        </div>
      )}

      {/* Bottom overlay: type + name + coords */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-5 z-10">
        <div className="max-w-3xl mx-auto">

          <span className="inline-block text-[11px] font-bold uppercase tracking-widest text-[var(--bg-primary)] bg-[var(--accent)] px-3 py-1 rounded-md mb-3">
            {label}
          </span>

          <h1
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-[var(--text-primary)] leading-tight mb-3"
            style={{ fontFamily: 'var(--font-playfair)', textShadow: '0 2px 12px rgba(0,0,0,0.35)' }}
          >
            {name}
          </h1>

          {hasCoords && (
            <button
              onClick={copyCoords}
              className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] font-mono hover:text-[var(--text-primary)] transition-colors"
            >
              {copied
                ? <><Check className="w-3 h-3 text-[var(--success)]" /> Скопировано</>
                : <><Copy className="w-3 h-3" /> {coordStr}</>
              }
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
