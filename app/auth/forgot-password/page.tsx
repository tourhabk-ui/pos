import type { Metadata } from 'next';
import ForgotPasswordClient from './_ForgotPasswordClient';

export const metadata: Metadata = {
  title: 'Сброс пароля',
  description: 'Запрос ссылки для сброса пароля на Ведаре',
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordClient />;
}
