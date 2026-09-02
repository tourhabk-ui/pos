import type { Metadata } from 'next';
import TransfersClient from './_TransfersClient';

export const metadata: Metadata = {
  title: 'Места в поездках перевозчиков — Камчатка',
  description:
    'Свободные места в джипах и вахтовках перевозчиков Камчатки: к вулканам, источникам и на побережье. Запрос места, подтверждение перевозчика, оплата по СБП.',
};

export default function TransfersPage() {
  return <TransfersClient />;
}
