import type { Metadata } from 'next';
import TrackImportsClient from './_TrackImportsClient';

export const metadata: Metadata = {
  title: 'Треки из поля — Admin',
  robots: 'noindex, nofollow',
};

export default function TrackImportsPage() {
  return <TrackImportsClient />;
}
