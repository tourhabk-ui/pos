import { Metadata } from 'next';
import { ReactNode } from 'react';

export const metadata: Metadata = {
  title: {
    // Шаблон заголовков — поисковые метаданные, а не текст документа: старый
    // бренд уходил в выдачу у пяти страниц sitemap (аудит SEO 29.09, вечер).
    // Тела юрдокументов и REQUISITES не тронуты — это правовое решение.
    template: '%s | Ведар',
    default: 'Правовые документы | Ведар',
  },
  description: 'Правовые документы платформы Ведар (vedarai.ru)',
};

export default function LegalLayout({ children }: { children: ReactNode }) {
  return children;
}
