import type { Metadata } from 'next';
import CarrierReviewsClient from './_CarrierReviewsClient';

export const metadata: Metadata = {
  title: 'Отзывы о перевозчиках — модерация',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <CarrierReviewsClient />;
}
