'use client';

import { Camera } from 'lucide-react';

/** Якорь формы загрузки на карточке места (PhotoUpload в «Отзывы, фото и наблюдения»). */
export const PLACE_PHOTO_UPLOAD_ANCHOR = 'place-photo-upload';

/**
 * «Был тут? Добавь фото» — к форме загрузки на этой же карточке.
 *
 * До 04.10 строка звала «поделиться фото в @kamchatka_real». Это наш канал
 * публикаций: писать туда может только админ, и ничто не возвращает снимок
 * оттуда на карточку места — обещание без механизма (CLAUDE.md, правило
 * 10.09). Рабочий путь был рядом: PhotoUpload с модерацией, свёрнутый в
 * «Отзывы, фото и наблюдения». Решение владельца 04.10: «так и нужно».
 *
 * Без JS ссылка остаётся якорем: браузер сам раскрывает <details>, внутри
 * которого лежит цель перехода. С JS — раскрываем явно (Safari старше 17
 * этого не делает) и прокручиваем.
 */
export default function AddPhotoLink() {
  return (
    <a
      href={`#${PLACE_PHOTO_UPLOAD_ANCHOR}`}
      onClick={(e) => {
        const target = document.getElementById(PLACE_PHOTO_UPLOAD_ANCHOR);
        if (!target) return;
        e.preventDefault();
        const details = target.closest('details');
        if (details) details.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}
      className="inline-flex items-center gap-1.5 hover:text-[var(--ocean)] transition-colors"
    >
      <Camera className="w-3 h-3" aria-hidden />
      Был тут? Добавь фото
    </a>
  );
}
