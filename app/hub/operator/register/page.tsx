import type { Metadata } from 'next';
import OperatorRegisterClient from './_RegisterClient';

export const metadata: Metadata = {
  title: 'Регистрация оператора',
  description: 'Присоединись к платформе. 0% комиссия в апреле.',
};

export default function OperatorRegisterPage() {
  return <OperatorRegisterClient />;
}
