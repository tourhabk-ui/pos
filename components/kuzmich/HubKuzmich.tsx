'use client';

/**
 * Плавающая кнопка Кузьмича на всём сайте, кроме кабинетов.
 * В /hub уже есть чат кабинета; вторая кнопка на 390px накрывает заголовки.
 */
import { usePathname } from 'next/navigation';
import KuzmichWidget from '@/components/kuzmich/KuzmichWidget';

export default function HubKuzmich() {
  const path = usePathname() ?? '';
  if (path.startsWith('/hub/')) return null;
  return <KuzmichWidget />;
}
