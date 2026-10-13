import type { Metadata } from 'next';

/**
 * Управление скачанным на телефон — личный экран, а не страница для выдачи.
 * Клиентская страница метаданных не несла и индексировалась с заголовком
 * сайта по умолчанию (разбор SEO 13.10).
 */
export const metadata: Metadata = {
  title: 'Скачанное для офлайна',
  robots: { index: false, follow: true },
};

export default function OfflineManageLayout({ children }: { children: React.ReactNode }) {
  return children;
}
