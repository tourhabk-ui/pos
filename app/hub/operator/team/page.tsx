import { Metadata } from 'next';
import TeamClient from './_TeamClient';

export const metadata: Metadata = {
  title: 'Команда | Оператор',
  description: 'Менеджеры кабинета: приглашение по ссылке, права на цены и отмену броней',
  robots: 'noindex, nofollow',
};

export default function OperatorTeamPage() {
  return <TeamClient />;
}
