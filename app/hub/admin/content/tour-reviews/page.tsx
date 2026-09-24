import type { Metadata } from 'next';
import TourReviewsClient from './_TourReviewsClient';

export const metadata: Metadata = {
  title: 'Отзывы о турах — модерация',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <TourReviewsClient />;
}
