import type { Metadata } from 'next';
import { InboxScreen } from '@/components/crm/InboxScreen';

export const metadata: Metadata = {
  title: 'Входящие | Перевозчик',
  description: 'Что ждёт ответа партнёра и как быстро он отвечает',
  robots: 'noindex, nofollow',
};

export default function CarrierInboxPage() {
  return <InboxScreen />;
}
