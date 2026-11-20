'use client';

import { usePathname } from 'next/navigation';
import { showSiteFooter } from '@/lib/navigation/site-footer-paths';
import { isForeignSurface } from '@/lib/embed/widget-frame';

/**
 * Общий подвал из корневого layout. Клиентский только ради usePathname —
 * Next рендерит его на сервере, и подвал (ссылки, реквизиты) есть в исходном
 * HTML (Сыщик 21.11). Сам <Footer /> приходит серверным children.
 */
export function SiteFooter({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Виджет и сайт партнёра — чужая поверхность: меню Ведара там не ставится.
  if (isForeignSurface(pathname)) return null;
  return showSiteFooter(pathname) ? <>{children}</> : null;
}
