import type { Metadata } from 'next';
import { EquipmentClient } from './_EquipmentClient';

export const metadata: Metadata = {
  title: 'Чек-лист снаряжения — Ведар',
  description: 'AI-генератор списка снаряжения для маршрутов Камчатки. Укажи маршрут и дату поездки — получи персональный чек-лист.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/tools/equipment' },
};

export default function EquipmentPage() {
  return <EquipmentClient />;
}
