'use client';

/**
 * Лента фото перевозчика: снимок открывается на весь экран, а не сырым файлом
 * в новой вкладке (владелец 09.10: «галерея не открывается»). Просмотрщик —
 * общий (components/shared/PhotoLightbox), подпись автора идёт с снимком и в
 * ленте, и в просмотрщике: автор назван не у всех, и общая строка приписала
 * бы чужие кадры перевозчику.
 */
import Image from 'next/image';
import { useState } from 'react';
import { PhotoLightbox } from '@/components/shared/PhotoLightbox';
import { photoSrc } from '@/lib/images/variant';

export function CharterPhotos({ name, photos }: {
  name: string;
  photos: ReadonlyArray<{ url: string; credit: string | null }>;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const captions = photos.map((ph) => `Фото: ${ph.credit ?? name}`);
  return (
    <div>
      <ul className="flex gap-2 overflow-x-auto pb-2 snap-x" aria-label={`Фото: ${name}`}>
        {photos.map((ph, i) => (
          <li key={ph.url} className="snap-start shrink-0 w-40">
            <button
              type="button"
              onClick={() => setOpen(i)}
              className="block relative w-40 h-28 rounded-lg overflow-hidden bg-[var(--bg-hover)]"
              aria-label={`Открыть фото ${i + 1} из ${photos.length}`}
            >
              <Image
                src={photoSrc(ph.url, 320)}
                alt={`${name}: фото ${i + 1}`}
                fill
                className="object-cover"
                sizes="160px"
                loading="lazy"
              />
            </button>
            <p className="mt-1 text-[11px] leading-tight text-[var(--text-muted)] line-clamp-2">{captions[i]}</p>
          </li>
        ))}
      </ul>
      {open !== null && (
        <PhotoLightbox
          images={photos.map((ph) => ph.url)}
          alt={name}
          startIdx={open}
          captions={captions}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
