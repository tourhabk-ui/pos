import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SOS — Экстренная помощь',
  description: 'Экстренная помощь на Камчатке: отправить координаты, позвонить 112, МЧС, офлайн-сигнал.',
  alternates: { canonical: '/sos' },
};

export default function SosLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
