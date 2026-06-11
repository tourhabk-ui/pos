import { Metadata } from 'next';
import OperatorsPageClient from '@/app/marketplace/operators/_OperatorsClient';

export const metadata: Metadata = {
  title: 'Операторы Камчатки | Ведар',
  description: 'Проверенные туристические операторы Камчатки — экскурсии, рыбалка, треккинг, вертолётные туры',
};

export default function CatalogOperatorsPage() {
  return <OperatorsPageClient />;
}
