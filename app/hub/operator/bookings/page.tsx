import type { Metadata } from 'next';
import BookingsManagementClient from './_BookingsManagementClient';

export const metadata: Metadata = {
  title: 'Бронирования | Оператор',
  description: 'Управление бронированиями туров',
  robots: 'noindex, nofollow',
};

export default function BookingsManagement() {
  return <BookingsManagementClient />;
}
