'use client';

/**
 * Герой страницы перевозчика — первый снимок на всю ширину, по образцу
 * карточки тура (§11): поверх фото — крошки, заголовок и полоса фактов
 * (стекло поверх фото допустимо, §2). Снимок открывается в общем просмотрщике
 * со всеми фото перевозчика. Подпись автора — у героя тоже: автор назван не у
 * всех снимков, и без подписи чужой кадр читался бы снимком перевозчика.
 */

import Image from 'next/image';
import { useState, type ReactNode } from 'react';
import { Bus } from 'lucide-react';
import { PhotoLightbox } from '@/components/shared/PhotoLightbox';
import { photoSrc } from '@/lib/images/variant';
import type { CharterPhoto } from '@/lib/transfers/charter-format';

export function CarrierHero({ name, photos, children }: {
  name: string;
  photos: ReadonlyArray<CharterPhoto>;
  /** Текст поверх снимка: крошки, заголовок, полоса фактов. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const hero = photos[0] ?? null;
  const captions = photos.map((ph) => `Фото: ${ph.credit ?? name}`);

  return (
    <header className="relative overflow-hidden" style={{ height: 'min(60vh, 520px)', minHeight: 360, background: 'var(--bg-hover)' }}>
      {hero ? (
        <button type="button" className="absolute inset-0 w-full h-full" onClick={() => setOpen(0)}
          aria-label={`Открыть фото: ${name}`}>
          <Image src={photoSrc(hero.url, 1280)} alt={name} fill priority sizes="100vw" className="object-cover"
            style={{ objectPosition: '50% 40%' }} />
        </button>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <Bus className="w-16 h-16 text-[var(--text-muted)]" />
        </div>
      )}
      {/* Скрим без прозрачного окна посередине: верх держит шапку, низ — текст. */}
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-black/50 via-black/25 to-black/85" />
      <div className="absolute inset-x-0 bottom-0 pointer-events-none">
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
