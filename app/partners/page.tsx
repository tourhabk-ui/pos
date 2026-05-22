import type { Metadata } from 'next';
import PartnersClient from './_PartnersClient';

export const metadata: Metadata = {
  title: 'Планирование поездки — авиабилеты, отели, трансферы на Камчатку | Ведар',
  description: 'Авиабилеты до Петропавловска, отели, трансферы из аэропорта и страховка для путешествия на Камчатку. Партнёрские сервисы Ведар.',
};

export default function PartnersPage() {
  return <PartnersClient />;
}
