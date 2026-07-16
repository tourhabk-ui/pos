import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Header } from '@/components/layout/Header';
import MarketplaceClient from '@/components/marketplace/MarketplaceClient';
import { queryMarketplaceToursForPage, type MarketplaceToursResult } from '@/lib/search';
import { parseMarketplaceSearchParams, buildToursItemListJsonLd } from '@/lib/tours/marketplace-page';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Реальные туры по Камчатке от операторов',
  description: 'Честный каталог реальных туров по Камчатке от проверенных операторов. Сначала выбор и проверка деталей, потом заявка или бронирование.',
  keywords: [
    'туры Камчатка',
    'бронирование туров Камчатка',
    'рыболовные туры Камчатка',
    'восхождение на вулканы Камчатка',
    'термальные источники тур',
  ],
  alternates: {
    canonical: `${SITE}/marketplace`,
  },
  openGraph: {
    title: 'Реальные туры по Камчатке',
    description: 'Проверенные операторы, реальные предложения и честные условия без серых схем.',
    type: 'website',
    url: `${SITE}/marketplace`,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Реальные туры по Камчатке',
    description: 'Каталог реальных туров от операторов Камчатки с прозрачными условиями.',
  },
};

interface PageProps {
  // Next 15: searchParams — Promise, обязателен await.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Страница-близнец /catalog (см. комментарий там): один запрос через общий
 * data-слой кормит и JSON-LD, и видимую разметку первого рендера.
 */
export default async function MarketplacePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { filters, initialKey } = parseMarketplaceSearchParams(sp);

  let initial: MarketplaceToursResult | null = null;
  try {
    initial = await queryMarketplaceToursForPage(filters);
  } catch {
    initial = null;
  }

  const structuredData = initial ? buildToursItemListJsonLd(initial.tours, SITE, '/marketplace') : null;

  return (
    <>
      {structuredData && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      )}
      <Header />
      <Suspense>
        <MarketplaceClient
          initialTours={initial?.tours ?? []}
          initialTotal={initial?.total ?? 0}
          initialKey={initial === null ? null : initialKey}
        />
      </Suspense>
    </>
  );
}
