import type { Metadata } from 'next';
import ProfilePageClient from './_ProfilePageClient';

// Личный кабинет — не для выдачи (разбор SEO 13.10: noindex не было).
export const metadata: Metadata = {
  title: 'Профиль пользователя',
  description: 'Управление профилем и настройками аккаунта на Ведаре',
  robots: { index: false, follow: false },
};

export default function ProfilePage() {
  return <ProfilePageClient />;
}
