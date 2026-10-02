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

/**
 * Кадр 1200×630 (срез 02.10: квадрат 1024×1024 героя в сниппете мессенджеров
 * и соцсетей обрезался по бокам). Сделан из того же снимка героя:
 * `sharp(hero-light.jpeg).resize(1200, 630, { fit: 'cover' })`.
 */
export const DEFAULT_OG_IMAGE = '/images/og/vedar-1200x630.jpg';

export function defaultOgImages(): OgImage[] {
  return [
    {
      url: DEFAULT_OG_IMAGE,
      width: 1200,
      height: 630,
      alt: 'Ведар — Туры на Камчатку',
    },
  ];
}
