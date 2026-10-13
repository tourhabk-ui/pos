import type { Metadata } from 'next';
import CalendarClient from './_CalendarClient';

export const metadata: Metadata = {
  title: 'Календарь туров',
  description: 'Выберите дату и найдите доступные туры на Камчатке: треккинг, рыбалка, вертолётные экскурсии, наблюдение за медведями.',
  alternates: { canonical: '/calendar' },
};

export default function CalendarPage() {
  return <CalendarClient />;
}
