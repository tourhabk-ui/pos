'use client';

/**
 * Галерея страницы оператора /operators/[slug] — снимки открываются.
 *
 * До 09.10 сетка рисовала фото простыми блоками без нажатия: владелец открыл
 * с телефона «Галерею» перевозчика «Шатун», и ни одно фото не открылось
 * («галерея не открывается»). Плитка теперь кнопка, просмотрщик общий
 * (components/shared/PhotoLightbox) — тот же, что у карточки тура.
 *
 * В сетке шесть снимков, как было; в просмотрщике — все. Сколько осталось за
 * кадром, сказано на шестой плитке, иначе седьмое фото было бы недостижимо.
 */
import Image from 'next/image';
import { useState } from 'react';
import { PhotoLightbox } from '@/components/shared/PhotoLightbox';
import { TOUR_PHOTO_POSITION } from '@/lib/tours/photo-focus';

const SHOWN = 6;

export function OperatorGallery({ images, name, captions }: {
  images: string[];
  name: string;
  /** Подпись под снимком (автор) по индексу — у перевозчика; нет — без подписи. */
  captions?: string[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = images.slice(0, SHOWN);
  const rest = images.length - shown.length;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {shown.map((url, i) => (
          <figure key={`${i}-${url}`} className="min-w-0">
            <button
              type="button"
              onClick={() => setOpen(i)}
              className="relative block w-full h-40 rounded-lg overflow-hidden bg-[var(--bg-hover)] group"
              aria-label={`Открыть фото ${i + 1} из ${images.length}`}
            >
              <Image
                src={url}
                alt={`${name} ${i + 1}`}
                fill
                className="object-cover group-hover:scale-105 transition-transform duration-300"
                style={{ objectPosition: TOUR_PHOTO_POSITION }}
                sizes="(max-width: 640px) 50vw, 33vw"
              />
              {rest > 0 && i === shown.length - 1 && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-lg font-semibold">
                  +{rest}
                </span>
              )}
            </button>
            {captions?.[i] && (
              <figcaption className="mt-1 text-[11px] leading-tight text-[var(--text-muted)] line-clamp-1">{captions[i]}</figcaption>
            )}
          </figure>
        ))}
      </div>
      {open !== null && (
        <PhotoLightbox images={images} alt={name} startIdx={open} captions={captions} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
