import type { Metadata } from 'next';
import { MyKamchatkaClient } from './_MyKamchatkaClient';

export const metadata: Metadata = {
  title: 'Моя Камчатка — личный дашборд',
  description: 'Ваши туры, eco-баллы, достижения и рекомендации Кузьмича.',
  robots: { index: false, follow: false },
};

export default function MyKamchatkaPage() {
  return <MyKamchatkaClient />;
}
