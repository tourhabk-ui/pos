import { Metadata } from 'next';
import OperatorReviewsClient from './_OperatorReviewsClient';

export const metadata: Metadata = {
  title: 'Отзывы о турах',
  robots: 'noindex, nofollow',
};

export default function OperatorReviewsPage() {
  return <OperatorReviewsClient />;
}
