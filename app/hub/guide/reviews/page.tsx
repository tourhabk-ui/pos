import { Metadata } from 'next';
import GuideReviewsClient from './_GuideReviewsClient';

export const metadata: Metadata = {
  title: 'Отзывы о гиде',
  robots: 'noindex, nofollow',
};

export default function GuideReviewsPage() {
  return <GuideReviewsClient />;
}
