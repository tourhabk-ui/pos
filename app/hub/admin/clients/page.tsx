import type { Metadata } from 'next';
import { ContactsScreen } from '@/components/crm/ContactsScreen';

export const metadata: Metadata = {
  title: 'Клиенты партнёров | Админ',
  description: 'Клиенты всех партнёров платформы: у кого клиент, откуда и когда пришёл',
  robots: 'noindex, nofollow',
};

export default function AdminClientsPage() {
  return <ContactsScreen mode="admin" />;
}
