import type { Metadata } from 'next';
import CheckinClient from './_CheckinClient';

export const metadata: Metadata = {
  title: 'Чекин туриста — Ведар',
  description: 'Зарегистрируйте ожидаемое время возврата. Если вы не отмените чекин вовремя, ваш экстренный контакт получит уведомление.',
};

export default function CheckinPage() {
  return <CheckinClient />;
}
