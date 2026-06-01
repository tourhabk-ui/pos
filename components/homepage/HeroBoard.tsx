'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight, Bot, Map } from 'lucide-react';

const IMAGES = [
  '/images/hero/IMG_20260316_133026.jpg',
  '/images/hero/IMG_20260316_133049.jpg',
  '/images/hero/IMG_20260316_133133.jpg',
];

export function HeroBoard() {
  const [visible, setVisible] = useState(false);
  const [imgIdx, setImgIdx] = useState(0);
  const [loaded, setLoaded] = useState<Set<number>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 80);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setImgIdx(i => (i + 1) % IMAGES.length), 7000);
    return () => clearInterval(id);
  }, []);

  return (
    <section
      className="relative overflow-hidden"
      style={{
        minHeight: '82vh',
        background: 'linear-gradient(160deg, #1a0f0a 0%, #3d1c0c 25%, #5c2d16 45%, #2a3a4a 70%, #111c28 100%)',
      }}
    >
      {IMAGES.map((src, i) => (
        <div
          key={src}
          className="absolute inset-0 transition-opacity duration-1200"
          style={{ opacity: imgIdx === i && loaded.has(i) ? 1 : 0, transitionDuration: '1200ms' }}
        >
          <img
            src={src}
            alt="Камчатка"
            className="w-full h-full object-cover object-center"
            loading={i === 0 ? 'eager' : 'lazy'}
            fetchPriority={i === 0 ? 'high' : 'auto'}
            onLoad={() => setLoaded(prev => new Set(prev).add(i))}
          />
        </div>
      ))}

      {/* Refined overlay — let the photo breathe */}
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-primary)] via-[var(--bg-primary)]/40 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--bg-primary)]/30 to-transparent" />

      <div className="relative z-10 flex flex-col justify-end" style={{ minHeight: '82vh' }}>
        <div className="max-w-7xl mx-auto w-full px-4 md:px-8 pb-20 md:pb-28">

          {/* Thin accent rule — animates in */}
          <div
            className={`h-px bg-[var(--accent)] mb-7 transition-all duration-700 ${
              visible ? 'opacity-100 w-10' : 'opacity-0 w-0'
            }`}
          />

          <p
            className={`mb-4 text-[10px] font-semibold tracking-[0.4em] uppercase text-[var(--accent)] transition-all duration-500 ${
              visible ? 'opacity-100' : 'opacity-0 translate-y-2'
            }`}
          >
            Камчатка · штурман туриста
          </p>

          <h1
            className={`font-playfair font-bold leading-[1.03] text-[var(--text-primary)] transition-all duration-700 delay-100 ${
              visible ? 'opacity-100' : 'opacity-0 translate-y-4'
            }`}
            style={{ fontSize: 'clamp(3.2rem, 8vw, 6.5rem)' }}
          >
            Знай{' '}
            <em className="not-italic text-[var(--accent)] italic">куда идёшь</em>
          </h1>

          <p
            className={`mt-6 mb-9 max-w-md text-base leading-relaxed text-[var(--text-secondary)] transition-all duration-700 delay-200 ${
              visible ? 'opacity-100' : 'opacity-0 translate-y-4'
            }`}
          >
            778 мест, 294 маршрута, реальные опасности и статус вулканов —
            всё что нужно до выхода на маршрут.
          </p>

          <div
            className={`flex flex-wrap gap-3 transition-all duration-700 delay-300 ${
              visible ? 'opacity-100' : 'opacity-0 translate-y-4'
            }`}
          >
            <Link href="/planner" className="ds-btn ds-btn-primary gap-2 px-6 py-3 text-base">
              <Bot size={17} />
              Подобрать маршрут
              <ArrowRight size={16} />
            </Link>
            <Link href="/map" className="ds-btn ds-btn-secondary gap-2 px-6 py-3 text-base">
              <Map size={16} />
              Открыть карту
            </Link>
          </div>
        </div>
      </div>

      {/* Thin bar indicators */}
      <div className="absolute bottom-7 right-7 z-10 flex gap-1.5 items-center">
        {IMAGES.map((_, i) => (
          <button
            key={i}
            onClick={() => setImgIdx(i)}
            className={`rounded-full transition-all duration-500 ${
              imgIdx === i
                ? 'w-7 h-1 bg-[var(--accent)]'
                : 'w-2.5 h-1 bg-[var(--bg-primary)]/30 hover:bg-[var(--bg-primary)]/50'
            }`}
            aria-label={`Фото ${i + 1}`}
          />
        ))}
      </div>
    </section>
  );
}
