/**
 * Картинка превью по умолчанию — для страниц, у которых своей нет.
 *
 * Next.js заменяет `openGraph` страницы ЦЕЛИКОМ, а не сливает с layout:
 * страница, объявившая свой `openGraph` без `images`, теряет картинку из
 * app/layout.tsx. Проверено сборкой 01.10: у /guides, /faq, /about в
 * пререндере нет og:image, у /tools (своего openGraph нет) — есть. Аудит
 * того же дня: 464 страницы из 897 без картинки превью — маршруты, статьи,
 * рыбы, справка, — и ссылка на них в мессенджере раскрывалась голым текстом.
 *
 * Своя картинка страницы (снимок места, фото маршрута) всегда первее этой.
 * Новый массив на каждый вызов: метаданные разных страниц не делят объект.
 *
 * Сторож: tests/unit/og-image-everywhere.test.ts.
 */
export interface OgImage {
  url: string;
  width: number;
  height: number;
  alt: string;
}

export function defaultOgImages(): OgImage[] {
  return [
    {
      url: '/images/hero/hero-light.jpeg',
      width: 1024,
      height: 1024,
      alt: 'Ведар — Туры на Камчатку',
    },
  ];
}
