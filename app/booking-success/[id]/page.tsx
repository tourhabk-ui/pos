import { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import BookingSuccessClient from './_BookingSuccessClient';

export const metadata: Metadata = {
  title: 'Заявка на тур',
  description: 'Детали заявки на тур: оператор подтверждает дату, после подтверждения открывается оплата.'
};

/**
 * Общая шапка — знак Ведара и SOS (EmergencyAction внутри Header) на этом
 * экране тоже: §2 требует SOS на каждом экране, а до 24.09 страница после
 * заявки рисовала только свой клиент (#146). Своей SOS-кнопки здесь нет.
 */
export default function BookingSuccessPage() {
  return (
    <>
      <Header />
      <BookingSuccessClient />
    </>
  );
}
