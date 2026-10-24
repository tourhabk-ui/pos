'use client';

/**
 * Плавающая кнопка Кузьмича на всём сайте, кроме кабинетов и чужой поверхности.
 * В /hub уже есть чат кабинета; вторая кнопка на 390px накрывает заголовки.
 * Виджет и сайт партнёра (isForeignSurface) эту кнопку не получают: иначе
 * корневой layout увёз бы её в чужой iframe.
 */
import { usePathname } from 'next/navigation';
import KuzmichWidget from '@/components/kuzmich/KuzmichWidget';
import { isForeignSurface } from '@/lib/embed/widget-frame';

export default function HubKuzmich() {
  const path = usePathname() ?? '';
  if (isForeignSurface(path) || path === '/hub' || path.startsWith('/hub/')) return null;
  return <KuzmichWidget />;
}
