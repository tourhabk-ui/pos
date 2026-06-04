'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, Copy, Check, Images } from 'lucide-react';
import { useState, useRef } from 'react';
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
  const [copied, setCopied] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const label = LOCATION_TYPE_LABELS[locationType ?? 'other'] ?? 'Место';
  const imgSrc = photoUrl ?? (photoCount > 0 ? `/api/images/route/${placeId}` : null);
  const coordStr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  // Build gallery: prefer images[] if multiple, else single imgSrc
  const gallery = images && images.length > 1
    ? images.filter(s => typeof s === 'string' && s.length > 0)
    : (imgSrc ? [imgSrc] : []);
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
    setCurrentIdx(idx);
  }

  return (
    <div className="relative w-full overflow-hidden bg-[var(--bg-hover)]" style={{ height: 'clamp(320px, 68vh, 720px)' }}>

      {/* Photo / Gallery */}
      {isGallery ? (
        <div
          ref={scrollRef}
          className="flex h-full overflow-x-auto snap-x snap-mandatory"
          style={{ scrollbarWidth: 'none' }}
          onScroll={handleScroll}
        >
          {gallery.map((src, i) => (
            <div key={i} className="flex-shrink-0 w-full snap-start relative h-full">
              <Image src={src} alt={`${name} ${i + 1}`} fill className="object-cover" priority={i === 0} sizes="100vw" />
            </div>
          ))}
        </div>
      ) : gallery.length === 1 ? (
        <Image src={gallery[0]} alt={name} fill className="object-cover" priority sizes="100vw" />
      ) : (
        <RouteGradientPlaceholder title={name} locationType={locationType} className="w-full h-full" showLabel={false} />
      )}

      {/* Deep gradient from bottom */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent pointer-events-none" />

      {/* Dot indicators for gallery */}
      {isGallery && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex gap-1.5 z-20">
          {gallery.map((_, i) => (
            <div key={i} className={`rounded-full transition-all duration-200 ${
              i === currentIdx ? 'w-4 h-1.5 bg-white' : 'w-1.5 h-1.5 bg-white/40'
            }`} />
          ))}
        </div>
      )}

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 pt-20 pb-4 z-20">
        <Link
          href="/routes?kind=place"
          className="inline-flex items-center gap-1.5 text-sm text-white/90 bg-black/50 px-3 py-1.5 rounded-full border border-white/15 hover:bg-black/70 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Все места
        </Link>

        {(isGallery ? gallery.length : photoCount) > 1 && (
          <span className="inline-flex items-center gap-1.5 text-xs text-white/80 bg-black/40 px-2.5 py-1.5 rounded-full border border-white/15">
            <Images className="w-3.5 h-3.5" />
            {isGallery ? `${currentIdx + 1}/${gallery.length}` : photoCount}
          </span>
        )}
      </div>

      {/* Bottom overlay: type + name + coords */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-5 z-10 pointer-events-none">
        <div className="max-w-3xl mx-auto">
          <span className="inline-block text-[11px] font-bold uppercase tracking-widest text-white bg-[var(--accent)] px-3 py-1 rounded-full mb-3">
            {label}
          </span>
          <h1
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-tight mb-3"
            style={{ fontFamily: 'var(--font-playfair)', textShadow: '0 2px 12px rgba(0,0,0,0.4)' }}
          >
            {name}
          </h1>
          <button
            onClick={copyCoords}
            className="inline-flex items-center gap-1.5 text-xs text-white/60 font-mono hover:text-white transition-colors pointer-events-auto"
          >
            {copied
              ? <><Check className="w-3 h-3 text-[var(--success)]" /> Скопировано</>
              : <><Copy className="w-3 h-3" /> {coordStr}</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}
