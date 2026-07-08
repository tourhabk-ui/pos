import type { Metadata } from 'next';
import StaysClient from './_StaysClient';

export const metadata: Metadata = {
  title: 'Мои проживания | Tourhab',
  description: 'Брони жилья',
  robots: 'noindex, nofollow',
};

export default function TouristStaysPage() {
  return <StaysClient />;
}
