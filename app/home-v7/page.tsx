import type { Metadata } from 'next';
import HomeV8Client from './_HomeV8Client';
import { getHomeV8Data } from './data';

/**
 * Превью редизайна Главной — v8 «Воронка» (на роуте /home-v7).
 * Server-компонент: тянет реальные данные (KVERT, алерты, зоны, платы, лид),
 * рендерит клиентский слой. Живая Главная (/) не затрагивается.
 * noindex — превью не должно попадать в поиск.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Главная — превью v8 «Воронка»',
  description: 'Превью редизайна главной страницы Ведар на реальных данных. Служебный роут, не для индексации.',
  robots: { index: false, follow: false },
};

export default async function HomeV7Page() {
  const data = await getHomeV8Data();
  return <HomeV8Client data={data} preview />;
}
