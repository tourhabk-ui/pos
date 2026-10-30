import type { Metadata } from 'next';
import RentalClient from './_RentalClient';

export const metadata: Metadata = {
  title: 'Прокат | Перевозчик',
  description: 'Машины прайса, заявки на прокат и календарь занятости',
  robots: 'noindex, nofollow',
};

export default function CarrierRentalPage() {
  return <RentalClient />;
}
