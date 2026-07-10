import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { KuzmichHub } from '@/components/kuzmich/KuzmichHub';

export const metadata: Metadata = {
  title: 'Кузьмич Хаб — путеводитель по Камчатке',
  description: 'Точка входа в экосистему Камчатки: маршруты по стихиям, погода, вулканы, AI-помощник Кузьмич.',
  robots: 'index, follow',
};

export default function KuzmichHubPage() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <main className="flex-1 pt-[56px]">
        <KuzmichHub />
      </main>
      <Footer />
    </div>
  );
}
