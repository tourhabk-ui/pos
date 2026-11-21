import type { Metadata } from 'next';
import { EquipmentClient } from './_EquipmentClient';

export const metadata: Metadata = {
  title: 'Чек-лист снаряжения',
  description: 'Чек-лист снаряжения для маршрутов Камчатки: снаряжение из паспорта маршрута, его опасности, обязательные шаги и общий минимум для любого выхода.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/tools/equipment' },
};

export default function EquipmentPage() {
  return <EquipmentClient />;
}
