'use client';

/**
 * Фото на весь экран — один просмотрщик на все галереи платформы: карточка
 * тура, страница оператора, лента перевозчика.
 *
 * До 09.10 он жил внутри карточки тура, а галерея страницы оператора рисовала
 * снимки без нажатия вовсе. Владелец открыл с телефона «Галерею» перевозчика —
 * и фото не открывались («галерея не открывается»). Лента перевозчика на
 * /transfers открывала сырой файл в новой вкладке. Второй просмотрщик рядом с
 * первым разошёлся бы поведением, поэтому он один и живёт здесь.
 *
 * Стекло тёмное поверх фото — допустимо по §2 CLAUDE.md. Закрыть — крестик,
 * клавиша Esc или нажатие мимо снимка; листать — стрелки, клавиши и свайп.
 */
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';

/** Сдвиг пальца, после которого свайп листает, а не случайно дрогнул. */
const SWIPE_PX = 50;

export function PhotoLightbox({ images, alt, startIdx, onClose, captions }: {
  images: string[];
  alt: string;
  startIdx: number;
  onClose: () => void;
  /** Подпись под снимком по индексу (например, автор фото); нет — без подписи. */
  captions?: ReadonlyArray<string | null | undefined>;
}) {
  const [idx, setIdx] = useState(startIdx);
  const touchX = useRef<number | null>(null);
  const many = images.length > 1;
  const prev = () => setIdx((i) => (i - 1 + images.length) % images.length);
  const next = () => setIdx((i) => (i + 1) % images.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (many && e.key === 'ArrowLeft') setIdx((i) => (i - 1 + images.length) % images.length);
      else if (many && e.key === 'ArrowRight') setIdx((i) => (i + 1) % images.length);
    };
    window.addEventListener('keydown', onKey);
    // Под открытым снимком страница не прокручивается — на телефоне свайп
    // иначе листал бы и фото, и страницу под ним.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [images.length, many, onClose]);

  const caption = captions?.[idx] ?? null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${alt}: фото ${idx + 1} из ${images.length}`}
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-11 h-11 rounded-full bg-black/40 flex items-center justify-center text-white hover:bg-black/60 transition-colors z-10"
        aria-label="Закрыть"
      >
        <X className="w-5 h-5" />
      </button>
      <div
        className="relative w-full h-full flex items-center justify-center p-4 sm:p-12"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          touchX.current = null;
          const end = e.changedTouches[0]?.clientX;
          if (!many || start === null || end === undefined) return;
          if (end - start > SWIPE_PX) prev();
          else if (start - end > SWIPE_PX) next();
        }}
      >
        <Image src={images[idx]!} alt={`${alt} — фото ${idx + 1}`} fill className="object-contain" sizes="100vw" />
      </div>
      {caption && (
        <p className="absolute bottom-14 left-1/2 -translate-x-1/2 max-w-[90vw] text-center text-xs text-white/80">{caption}</p>
      )}
      {many && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); prev(); }}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/40 flex items-center justify-center text-white hover:bg-black/60 transition-colors"
            aria-label="Назад"
          >
            <ChevronRight className="w-6 h-6 rotate-180" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); next(); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/40 flex items-center justify-center text-white hover:bg-black/60 transition-colors"
            aria-label="Далее"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-1.5">
            {images.map((_, i) => (
              <button
                key={i}
                onClick={(e) => { e.stopPropagation(); setIdx(i); }}
                className={`h-2 rounded-full transition-all ${i === idx ? 'bg-white w-5' : 'bg-white/40 w-2'}`}
                aria-label={`Фото ${i + 1}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
