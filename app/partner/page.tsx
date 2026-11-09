import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import PartnerApplyClient from './_PartnerApplyClient';

export const metadata: Metadata = {
  alternates: { canonical: '/partner' },
  title: 'Подключить свой бизнес к Ведару — заявка для партнёров на Камчатке',
  description:
    'Туроператоры, рыбалка, гостевые дома, прокат автомобилей, трансферы и гиды Камчатки: заявки с сайта и от ИИ-помощников, ответ кнопками в MAX или Telegram. Оплату туристы вносят вам напрямую.',
};

export default function PartnerPage() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      <Header />
      <main className="pt-16">
        <PartnerApplyClient />
      </main>
      <Footer />
    </div>
  );
}
