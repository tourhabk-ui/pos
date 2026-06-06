import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import OperatorsPageClient from '@/app/marketplace/operators/_OperatorsClient';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Операторы Камчатки — туры, рыбалка, треккинг, вертолёты',
  description:
    'Проверенные туристические операторы Камчатки. Рыболовные туры, треккинг к вулканам, вертолётные экскурсии, медвежье сафари — выбирайте лицензированных профессионалов.',
  alternates: { canonical: `${SITE}/operators` },
  openGraph: {
    title: 'Операторы Камчатки',
    description: 'Проверенные туроператоры Камчатки — от рыбалки до вулканов.',
    url: `${SITE}/operators`,
    siteName: 'KamchatourHub',
    locale: 'ru_RU',
    type: 'website',
  },
};

export default function OperatorsPage() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      <Header />
      <main className="pt-16">
        <OperatorsPageClient />
      </main>
      <Footer />
    </div>
  );
}
