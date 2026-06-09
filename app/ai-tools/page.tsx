import type { Metadata } from 'next';
import { AIToolsClient } from './_AIToolsClient';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';

export const metadata: Metadata = {
  title: 'AI-арсенал Камчатки — инструменты для туриста',
  description: '48 проверенных AI-инструментов для путешествия на Камчатку: безопасность, навигация, определение растений и животных, офлайн-карты.',
  openGraph: {
    title: 'AI-арсенал Камчатки',
    description: 'Кураторский каталог инструментов для путешественников: от лавинных прогнозов до определения растений.',
    type: 'website',
  },
  alternates: { canonical: '/ai-tools' },
};

export default function AIToolsPage() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <main className="flex-1 pt-[56px]">
        <AIToolsClient />
      </main>
      <Footer />
    </div>
  );
}
