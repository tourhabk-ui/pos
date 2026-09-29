import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Виджеты партнёра (чат и форма заявки) живут в iframe на чужих сайтах.
 * Как самостоятельные страницы в выдаче им не место: до 29.09 `/widget/*`
 * отвечали поисковику 200 «index, follow» (аудит SEO 29.09, Н5). Сами
 * страницы клиентские и metadata объявить не могут — поэтому здесь.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function WidgetLayout({ children }: { children: ReactNode }) {
  return children;
}
