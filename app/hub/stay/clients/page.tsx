import type { Metadata } from 'next';
import { ContactsScreen } from '@/components/crm/ContactsScreen';

export const metadata: Metadata = {
  title: 'Клиенты | Жильё',
  description: 'Клиенты партнёра: контакты, метки, заметки и история обращений',
  robots: 'noindex, nofollow',
};

export default function StayClientsPage() {
  return <ContactsScreen />;
}
