import type { Metadata } from 'next';
import OperatorProfileClient from './_ProfileClient';

export const metadata: Metadata = {
  title: 'Профиль компании',
  robots: 'noindex, nofollow',
};

export default function OperatorProfilePage() {
  return <OperatorProfileClient />;
}
