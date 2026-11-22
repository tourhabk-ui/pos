'use client';

/**
 * Снимок тура дня с подписью автора — «день как журнал» (22.11). Только кадр,
 * у которого в базе есть подпись (lib/planner/print-photos: imageCaptions из
 * gallery_credits); без подписи кадра нет вовсе. Подпись видна всегда.
 * Кадр не загрузился — блока нет, а не пустая рамка.
 */
import { useState } from 'react';
import type { PrintPhoto } from '@/lib/planner/print-html';

export function DayPhoto({ photo }: { photo: PrintPhoto }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <figure className="relative m-0 overflow-hidden rounded-t-lg" data-day-photo>
      {/* Кадр оператора с его сервера изображений — без оптимизатора Next. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.src} alt="" decoding="async" onError={() => setBroken(true)}
        className="block w-full h-36 object-cover bg-[var(--bg-hover)]" />
      <figcaption className="absolute left-2 bottom-1.5 px-1.5 py-0.5 rounded bg-black/55 text-[10px] leading-none text-white">
        {photo.caption}
      </figcaption>
    </figure>
  );
}
