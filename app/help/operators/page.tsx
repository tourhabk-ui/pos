import type { Metadata } from 'next';
import OperatorsHelpClient from './_OperatorsHelpClient';

export const metadata: Metadata = {
  title: 'Инструкция для операторов ',
  description: 'Как разместить туры, принимать бронирования и получать выплаты на платформе Ведар',
};

export default function OperatorsHelpPage() {
  return <OperatorsHelpClient />;
}
