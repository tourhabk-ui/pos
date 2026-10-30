import type { Metadata } from 'next';
import OwnToursClient from './_OwnToursClient';

export const metadata: Metadata = {
  title: 'Свои туры | Кабинет гида',
  description: 'Брони и заявки по турам, которые гид продаёт сам, и его даты',
  robots: 'noindex, nofollow',
};

export default function GuideOwnToursPage() {
  return <OwnToursClient />;
}
