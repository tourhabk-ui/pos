import type { Metadata } from 'next';
import BookingHistoryPageClient from './_BookingHistoryPageClient';

export const metadata: Metadata = {
  title: 'Мои заявки',
  description: 'Список активных и прошедших заявок на туры',
  robots: 'noindex, nofollow',
};

export default function BookingHistoryPage() {
  return <BookingHistoryPageClient />;
}
