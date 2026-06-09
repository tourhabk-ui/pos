import type { Metadata } from 'next';
import { AccommodationsClient } from './_AccommodationsClient';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';

export const metadata: Metadata = {
  title: 'Жильё на Камчатке — отели, хостелы, глэмпинг',
  description: 'Проверенные отели, хостелы, кемпинги и глэмпинг на Камчатке. Бронирование с подтверждением, реальные цены.',
  openGraph: {
    title: 'Жильё на Камчатке',
    description: 'Отели, хостелы, глэмпинг и кемпинги — от центра Петропавловска до природных парков.',
    type: 'website',
  },
  alternates: { canonical: '/accommodations' },
};

export default function AccommodationsPage() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <main className="flex-1 pt-[56px]">
        <AccommodationsClient />
      </main>
      <Footer />
    </div>
  );
}
