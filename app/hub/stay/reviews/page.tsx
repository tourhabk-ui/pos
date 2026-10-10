import { Metadata } from 'next';
import StayReviewsClient from './_StayReviewsClient';

export const metadata: Metadata = {
  title: 'Отзывы гостей',
  robots: 'noindex, nofollow',
};

export default function StayReviewsPage() {
  return <StayReviewsClient />;
}
