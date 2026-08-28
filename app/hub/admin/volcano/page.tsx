import type { Metadata } from 'next';
import VolcanoClient from './_VolcanoClient';

export const metadata: Metadata = {
  title: 'Работа Volcano OS — TourHub Admin',
};

export default function VolcanoPage() {
  return <VolcanoClient />;
}
