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

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 80);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setImgIdx(i => (i + 1) % IMAGES.length), 6000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="relative overflow-hidden" style={{ minHeight: '78vh' }}>
      {/* Slideshow background */}
      {IMAGES.map((src, i) => (
        <div
          key={src}
          className="absolute inset-0 transition-opacity duration-1000"
          style={{ opacity: imgIdx === i ? 1 : 0 }}
        >
          <img
            src={src}
            alt="Камчатка"
            className="w-full h-full object-cover object-center"
            loading={i === 0 ? 'eager' : 'lazy'}
          />
        </div>
      ))}

      {/* Gradient overlay: photo at top, bg-primary at bottom */}
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-primary)] via-[var(--bg-primary)]/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--bg-primary)]/40 to-transparent" />

      {/* Content anchored to bottom-left */}
      <div
        className="relative z-10 flex flex-col justify-end"
        style={{ minHeight: '78vh' }}
      >
        <div className="max-w-7xl mx-auto w-full px-4 md:px-8 pb-16 md:pb-24">
          <p
            className={`mb-4 text-[11px] font-semibold tracking-[0.35em] uppercase text-[var(--accent)] transition-all duration-500 ${
              visible ? 'opacity-100' : 'opacity-0 translate-y-2'
            }`}
          >
            Туристическая платформа Камчатки
          </p>

          <h1
            className={`font-playfair font-bold leading-[1.05] text-[var(--text-primary)] transition-all duration-700 delay-100 ${
              visible ? 'opacity-100' : 'opacity-0 translate-y-4'
            }`}
            style={{ fontSize: 'clamp(2.4rem, 6vw, 5rem)' }}
          >
            Камчатка,{' '}
            <span className="text-[var(--accent)]">которую вы почувствуете</span>
            <br />
            по-настоящему
          </h1>

          <p
            className={`mt-5 mb-8 max-w-lg text-base leading-relaxed text-[var(--text-secondary)] transition-all duration-700 delay-200 ${
              visible ? 'opacity-100' : 'opacity-0 translate-y-4'
            }`}
          >
            Не маркетплейс туров — персональный инструмент планирования.
            AI, живая карта и только проверенные операторы.
          </p>

          <div
            className={`flex flex-wrap gap-3 transition-all duration-700 delay-300 ${
              visible ? 'opacity-100' : 'opacity-0 translate-y-4'
            }`}
          >
            <Link href="/planner" className="ds-btn ds-btn-primary gap-2">
              <Bot size={16} />
              Подобрать маршрут
              <ArrowRight size={15} />
            </Link>
            <Link href="/map" className="ds-btn ds-btn-secondary gap-2">
              <Map size={15} />
              Открыть карту
            </Link>
          </div>
        </div>
      </div>

      {/* Slideshow dots */}
      <div className="absolute bottom-6 right-6 z-10 flex gap-1.5">
        {IMAGES.map((_, i) => (
          <button
            key={i}
            onClick={() => setImgIdx(i)}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              imgIdx === i
                ? 'w-6 bg-[var(--accent)]'
                : 'w-1.5 bg-[var(--text-muted)]/50'
            }`}
            aria-label={`Фото ${i + 1}`}
          />
        ))}
      </div>
    </section>
  );
}
