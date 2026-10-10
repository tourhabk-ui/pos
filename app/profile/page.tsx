import type { Metadata } from 'next';
import ProfilePageClient from './_ProfilePageClient';

export const metadata = {
  title: 'Профиль пользователя',
  description: 'Управление профилем и настройками аккаунта на Ведаре',
};

export default function ProfilePage() {
  return <ProfilePageClient />;
}
