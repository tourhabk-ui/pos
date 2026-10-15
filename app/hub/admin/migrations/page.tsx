import type { Metadata } from 'next';
import MigrationsClient from './_MigrationsClient';

export const metadata: Metadata = {
  title: 'Миграции базы данных | Админ',
  description: 'Какие миграции не применены и почему — только чтение',
  robots: 'noindex, nofollow',
};

export default function AdminMigrationsPage() {
  return <MigrationsClient />;
}
