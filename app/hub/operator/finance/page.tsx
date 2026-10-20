import type { Metadata } from 'next';
import FinanceGate from './_FinanceGate';

export const metadata: Metadata = {
  title: 'Финансы | Оператор',
  description: 'Финансовый учёт и статистика оператора',
  robots: 'noindex, nofollow',
};

export default function FinancePage() {
  return <FinanceGate />;
}
