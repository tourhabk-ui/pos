import type { Metadata } from 'next';
import InventoryClient from './_InventoryClient';

export const metadata: Metadata = {
  title: 'Инвентарь снаряжения',
  description: 'Управление позициями проката снаряжения',
  robots: 'noindex, nofollow',
};

export default function GearInventoryPage() {
  return <InventoryClient />;
}
