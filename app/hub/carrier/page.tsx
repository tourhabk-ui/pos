import type { Metadata } from 'next';
import CarrierClient from './_CarrierClient';

export const metadata: Metadata = {
  title: 'Кабинет перевозчика',
  description: 'Парк, поездки и запросы мест перевозчика',
  robots: 'noindex, nofollow',
};

export default function CarrierPage() {
  return <CarrierClient />;
}
