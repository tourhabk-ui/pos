import type { Metadata } from 'next';
import { ContactsScreen } from '@/components/crm/ContactsScreen';

export const metadata: Metadata = {
  title: 'Клиенты | Гид',
  description: 'Клиенты партнёра: контакты, метки, заметки и история обращений',
  robots: 'noindex, nofollow',
};

export default function GuideClientsPage() {
  return <ContactsScreen />;
}
