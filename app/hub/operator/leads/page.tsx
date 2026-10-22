import type { Metadata } from 'next';
import LeadsClient from './_LeadsClient';

export const metadata: Metadata = {
  title: 'Заявки с сайта | Кабинет оператора',
};

export default function LeadsPage() {
  return <LeadsClient />;
}
