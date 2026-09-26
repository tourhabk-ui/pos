import type { Metadata } from 'next';
import NewAccommodationClient from './_NewAccommodationClient';

export const metadata: Metadata = {
  title: 'Новый объект | Tourhab',
  description: 'Добавить объект размещения',
  robots: 'noindex, nofollow',
};

export default function NewAccommodationPage() {
  return <NewAccommodationClient />;
}
