import type { Metadata } from 'next';
import { InboxScreen } from '@/components/crm/InboxScreen';

export const metadata: Metadata = {
  title: 'Входящие | Гид',
  description: 'Что ждёт ответа партнёра и как быстро он отвечает',
  robots: 'noindex, nofollow',
};

export default function GuideInboxPage() {
  return <InboxScreen />;
}
