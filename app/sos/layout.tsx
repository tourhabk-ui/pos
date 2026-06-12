import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SOS — Экстренная помощь | Ведар',
  description: 'Экстренная помощь на Камчатке: отправить координаты, позвонить 112, МЧС, офлайн-сигнал.',
  alternates: { canonical: '/sos' },
  robots: { index: false, follow: false },
};

export default function SosLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
