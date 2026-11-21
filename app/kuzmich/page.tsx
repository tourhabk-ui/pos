import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { JsonLd } from '@/components/seo/JsonLd';
import { defaultOgImages } from '@/lib/seo/og-image';
import {
  KUZMICH_PAGE_DESCRIPTION,
  KUZMICH_PAGE_TITLE,
  kuzmichWebApplicationJsonLd,
} from '@/lib/seo/kuzmich-page';
import KuzmichAbout, { KuzmichIntro } from './KuzmichAbout';
import KuzmichClient from './_KuzmichClient';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: KUZMICH_PAGE_TITLE,
  description: KUZMICH_PAGE_DESCRIPTION,
  robots: 'index, follow',
  alternates: { canonical: '/kuzmich' },
  openGraph: {
    images: defaultOgImages(),
    title: KUZMICH_PAGE_TITLE,
    description: KUZMICH_PAGE_DESCRIPTION,
    url: `${SITE}/kuzmich`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

export default function KuzmichPage() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <JsonLd data={kuzmichWebApplicationJsonLd(SITE)} />
      {/* Статья и FAQ — в серверном HTML до клиентского чата, чтобы бот
          без JS прочитал весь текст. Визуально чат остаётся под лидом
          (order-last у статьи). */}
      <main className="flex-1 flex flex-col max-w-3xl w-full mx-auto px-2 sm:px-4 pb-6 pt-20">
        <KuzmichIntro />
        <div className="order-last">
          <KuzmichAbout />
        </div>
        <KuzmichClient />
      </main>
    </div>
  );
}
