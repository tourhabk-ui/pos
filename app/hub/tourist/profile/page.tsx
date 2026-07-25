import { Metadata } from 'next';
import ProfileClient from './_ProfileClient';

export const metadata: Metadata = {
  title: 'Профиль',
  robots: 'noindex, nofollow',
};

export default function ProfilePage() {
  return <ProfileClient />;
}
