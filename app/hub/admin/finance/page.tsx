import type { Metadata } from 'next';
import AdminFinanceClient from './_AdminFinanceClient';

export const metadata: Metadata = {
  title: 'Финансы | Панель администратора',
  description: 'Управление финансами и выплатами на платформе Ведар',
};

export default function AdminFinancePage() {
  return <AdminFinanceClient />;
}

