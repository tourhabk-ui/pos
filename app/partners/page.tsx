import type { Metadata } from 'next';
import PartnersClient from './_PartnersClient';

export const metadata: Metadata = {
  alternates: { canonical: '/partners' },
  title: 'Поездка на Камчатку: авиабилеты, отели, трансферы',
  description: 'Авиабилеты до Петропавловска, отели, трансферы из аэропорта и страховка для путешествия на Камчатку. Партнёрские сервисы Ведара.',
};

export default function PartnersPage() {
  return <PartnersClient />;
}
