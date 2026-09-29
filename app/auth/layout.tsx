import { Metadata } from 'next';
import { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Вход и регистрация',
  description: 'Вход в личный кабинет Ведара и регистрация.',
  // Служебный экран: в выдаче ему нечего делать (аудит SEO 29.09, Н5).
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  return children;
}
