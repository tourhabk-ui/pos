import type { Metadata } from 'next';

/**
 * Форма отзыва о месте — не страница для выдачи. Ссылка на неё стоит на
 * каждой карточке места (PlaceReviews), а у клиентской страницы своих
 * метаданных не было: поиск находил по адресу формы на каждое место, все с
 * заголовком сайта по умолчанию и без noindex (разбор SEO 13.10).
 */
export const metadata: Metadata = {
  title: 'Отзыв о месте',
  robots: { index: false, follow: true },
};

export default function PlaceReviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
