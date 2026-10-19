import type { Metadata } from 'next';
import CartClient from './_CartClient';

export const metadata: Metadata = {
  title: 'Корзина',
};

// Шапку и SOS рисует HubLayout кабинета (app/hub/tourist/layout.tsx).
// Своя шапка сайта здесь давала на мобильном вторую шапку и две
// наложенные SOS-кнопки (аудит кабинета туриста 20.10).
export default function CartPage() {
  return <CartClient />;
}
