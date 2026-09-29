import type { Metadata } from 'next';
import OperatorSitesClient from './_OperatorSitesClient';

export const metadata: Metadata = {
  title: 'Сайты операторов | Админ',
  description: 'Внешняя проверка сайтов операторов: сертификат, заголовки, раскрытие',
  robots: 'noindex, nofollow',
};

export default function AdminOperatorSitesPage() {
  return <OperatorSitesClient />;
}
