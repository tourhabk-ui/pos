import type { Metadata } from 'next';
import StayCalendarClient from './_StayCalendarClient';

export const metadata: Metadata = {
  title: 'Тарифный календарь | Tourhab',
  description: 'Цены и блокировки по датам для объектов размещения',
  robots: 'noindex, nofollow',
};

export default function StayCalendarPage() {
  return <StayCalendarClient />;
}
