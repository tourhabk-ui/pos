import type { Metadata } from 'next';
import HomeV7Client from './_HomeV7Client';

/**
 * Превью редизайна Главной — v7 «Воронка».
 * Отдельный роут: живая Главная (/) не затрагивается до одобрения владельцем.
 * noindex — превью не должно попадать в поиск, пока не станет боевым.
 */
export const metadata: Metadata = {
  title: 'Главная — превью v7 «Воронка»',
  description: 'Превью редизайна главной страницы Ведар. Служебный роут, не для индексации.',
  robots: { index: false, follow: false },
};

export default function HomeV7Page() {
  return <HomeV7Client />;
}
