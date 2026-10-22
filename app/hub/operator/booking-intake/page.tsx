import { Metadata } from 'next';
import BookingIntakeClient from './_BookingIntakeClient';

export const metadata: Metadata = {
  title: 'Приём заявок',
  robots: 'noindex, nofollow',
};

export default function BookingIntakePage() {
  return <BookingIntakeClient />;
}
