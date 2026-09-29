import type { Metadata } from 'next';
import AuthPageClient from './_AuthPageClient';

export const metadata: Metadata = {
  title: 'Вход',
  description: 'Вход в личный кабинет Ведара',
  robots: { index: false, follow: false },
};

export default function AuthPage() {
  return <AuthPageClient />;
}
