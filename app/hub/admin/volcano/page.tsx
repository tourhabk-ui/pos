import type { Metadata } from 'next';
import VolcanoTabs from './_VolcanoTabs';

export const metadata: Metadata = {
  title: 'Работа Volcano OS — TourHub Admin',
};

export default function VolcanoPage() {
  return <VolcanoTabs />;
}
