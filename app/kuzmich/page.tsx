import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import KuzmichClient from './_KuzmichClient';

export const metadata: Metadata = {
  title: 'Кузьмич — AI-помощник по турам Камчатки',
  description: 'Опишите мечту — AI-оператор Кузьмич подберёт лучший тур. Рыбалка, вулканы, медведи, горячие источники.',
  robots: 'index, follow',
  alternates: { canonical: '/kuzmich' },
};

export default function KuzmichPage() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <KuzmichClient />
      <BottomNav activePath="/kuzmich" />
    </div>
  );
}
