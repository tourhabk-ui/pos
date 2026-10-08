import type { Metadata } from 'next';
import ResetPasswordClient from './_ResetPasswordClient';

export const metadata: Metadata = {
  title: 'Новый пароль',
  description: 'Задать новый пароль по ссылке из письма',
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return <ResetPasswordClient />;
}
