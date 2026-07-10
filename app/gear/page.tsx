import type { Metadata } from 'next';
import GearClient from './_GearClient';

export const metadata: Metadata = {
  title: 'Аренда снаряжения на Камчатке',
  description:
    'Палатки, рюкзаки, спальники, треккинговое снаряжение в аренду от проверенных партнёров Камчатки. Цены за день, залог, бронирование онлайн.',
  alternates: { canonical: '/gear' },
};

export default function GearPage() {
  return <GearClient />;
}
