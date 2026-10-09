import type { Metadata } from 'next';
import { ContactsScreen } from '@/components/crm/ContactsScreen';

export const metadata: Metadata = {
  title: 'Клиенты | Прокат',
  description: 'Клиенты партнёра: контакты, метки, заметки и история обращений',
  robots: 'noindex, nofollow',
};

export default function GearClientsPage() {
  return <ContactsScreen />;
}
