import { Metadata } from 'next';
import { Suspense } from 'react';
import OperatorsPageClient from './_OperatorsClient';

export const metadata: Metadata = {
  title: 'Операторы Камчатки',
  description: 'Проверенные туристические операторы Камчатки — экскурсии, рыбалка, треккинг, вертолётные туры',
};

export default function OperatorsMarketplacePage() {
  // Suspense обязателен: клиент читает useSearchParams (deep-link фильтры),
  // без границы статический prerender этой страницы падает.
  return (
    <Suspense>
      <OperatorsPageClient />
    </Suspense>
  );
}
