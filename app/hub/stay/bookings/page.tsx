import type { Metadata } from 'next';
import BookingsClient from './_BookingsClient';

export const metadata: Metadata = {
  title: 'Брони жилья | Tourhab',
  description: 'Входящие брони объектов размещения',
  robots: 'noindex, nofollow',
};

export default function StayBookingsPage() {
  return <BookingsClient />;
}
