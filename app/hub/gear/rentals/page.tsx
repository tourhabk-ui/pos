import type { Metadata } from 'next';
import RentalsClient from './_RentalsClient';

export const metadata: Metadata = {
  title: 'Заявки на аренду | Tourhab',
  description: 'Управление заявками на аренду снаряжения',
  robots: 'noindex, nofollow',
};

export default function GearRentalsPage() {
  return <RentalsClient />;
}
