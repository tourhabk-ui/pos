import type { Metadata } from 'next';
import AccommodationModerationClient from './_AccommodationModerationClient';

export const metadata: Metadata = { title: 'Жильё: проверка | Kamchatour Admin', robots: 'noindex, nofollow' };

export default function AccommodationModerationPage() {
  return <AccommodationModerationClient />;
}
