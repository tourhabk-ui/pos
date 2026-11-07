import type { Metadata } from 'next';
import TaaftClient from './_TaaftClient';

export const metadata: Metadata = {
  title: 'Сторонние сервисы — Volcano OS',
  description: 'Чужие приложения, которые советует Кузьмич и показывает страница «Приложения в дорогу»',
};

export default function TaaftPage() {
  return <TaaftClient />;
}
