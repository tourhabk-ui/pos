import type { Metadata } from 'next';
import TransferOnboardingClient from './_TransferOnboardingClient';

export const metadata: Metadata = {
  title: 'Настройка кабинета | Оператор трансферов',
  description: 'Онбординг трансфер-оператора',
  robots: 'noindex, nofollow',
};

export default function TransferOnboardingPage() {
  return <TransferOnboardingClient />;
}
