import type { Metadata } from 'next';
import AccommodationModerationClient from './_AccommodationModerationClient';

export const metadata: Metadata = { title: 'Жильё: проверка | Админ', robots: 'noindex, nofollow' };

export default function AccommodationModerationPage() {
  return <AccommodationModerationClient />;
}
