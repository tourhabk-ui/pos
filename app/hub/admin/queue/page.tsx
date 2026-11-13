import type { Metadata } from 'next';
import ManagerQueueClient from './_ManagerQueueClient';

export const metadata: Metadata = {
  title: 'Очередь менеджера — после отказа',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <ManagerQueueClient />;
}
