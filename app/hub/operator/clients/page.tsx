import type { Metadata } from 'next';
import { ContactsScreen } from '@/components/crm/ContactsScreen';

export const metadata: Metadata = {
  title: 'Клиенты | Оператор',
  description: 'Клиенты оператора: брони и суммы, сегменты, метки, заметки и история обращений',
  robots: 'noindex, nofollow',
};

export default function OperatorClientsPage() {
  return <ContactsScreen />;
}
