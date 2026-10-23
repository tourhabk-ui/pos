'use client';

/**
 * Герой страницы прокатчика — по образцу героя перевозчика (CarrierHero):
 * первый снимок на всю ширину, поверх — крошки, заголовок и полоса фактов
 * (стекло поверх фото допустимо, §2). Снимок открывается в общем просмотрщике.
 *
 * Фото у прокатчика может не быть вовсе — тогда вместо снимка знак машины на
 * сплошной подложке, и это главный путь: у первого прокатчика («Лагуна
 * Прокат», 1318) снимков нет.
 */

import { useState, type ReactNode } from 'react';
import { Car } from 'lucide-react';
import { HeroPhoto } from '@/components/media/HeroPhoto';
import { PhotoLightbox } from '@/components/shared/PhotoLightbox';
import type { CharterPhoto } from '@/lib/transfers/charter-format';

export function RentalHero({ name, photos, children }: {
  name: string;
  photos: ReadonlyArray<CharterPhoto>;
  /** Текст поверх снимка: крошки, заголовок, полоса фактов. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const hero = photos[0] ?? null;
  const captions = photos.map((ph) => `Фото: ${ph.credit ?? name}`);

  return (
    <header className="relative overflow-hidden flex flex-col justify-end" style={{ minHeight: 'max(360px, min(60vh, 520px))', background: 'var(--bg-hover)' }}>
      {hero ? (
        <button type="button" className="absolute inset-0 w-full h-full" onClick={() => setOpen(0)}
          aria-label={`Открыть фото: ${name}`}>
          <HeroPhoto src={hero.url} alt={name} objectPosition="50% 40%" />
        </button>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <Car className="w-16 h-16 text-[var(--text-muted)]" />
        </div>
      )}
      {/* Скрим без прозрачного окна посередине: верх держит шапку, низ — текст. */}
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-black/50 via-black/25 to-black/85" />
      {/* Текст — в потоке, а не поверх: длинное описание и полоса фактов
          растят героя, а не уезжают под шапку (снимок с телефона 23.10 —
          логотип прокатчика обрезало сверху). pt-24 — место под прозрачную
          шапку сайта. */}
      <div className="relative pt-24 pointer-events-none">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 pointer-events-auto">{children}</div>
      </div>
      {hero && (
        <p className="absolute right-3 bottom-2 text-[11px] text-white/75 pointer-events-none">{captions[0]}</p>
      )}
      {open !== null && (
        <PhotoLightbox
          images={photos.map((ph) => ph.url)}
          alt={name}
          startIdx={open}
          captions={captions}
          onClose={() => setOpen(null)}
        />
      )}
    </header>
  );
}
