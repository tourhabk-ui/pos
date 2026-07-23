import type { Metadata } from 'next';
import ModelsClient from './_ModelsClient';

export const metadata: Metadata = {
  title: 'Модели эволюции — TourHub Admin',
  robots: 'noindex, nofollow',
};

export default function EvoModelsPage() {
  return <ModelsClient />;
}
