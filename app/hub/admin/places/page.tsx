import type { Metadata } from 'next';
import PlacesCleanupClient from './_PlacesCleanupClient';

export const metadata: Metadata = {
  title: 'Чистка мест — админ',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <PlacesCleanupClient />;
}
