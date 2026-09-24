import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Header } from '@/components/layout/Header';
import MarketplaceClient from '@/components/marketplace/MarketplaceClient';
import BottomNav from '@/components/shared/BottomNav';
import { CatalogFooter } from '@/components/marketplace/CatalogFooter';
import {
  queryMarketplaceToursForPage,
  queryCatalogSummaryForPage,
  type MarketplaceToursResult,
  type CatalogSummary,
} from '@/lib/search';
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

  // Отказ не глушится (§4.0): null — «не знаю», клиент дозапросит туры сам,
  // а в лог уходит имя запроса и SQLSTATE.
  const [toursRes, summaryRes] = await Promise.allSettled([
    queryMarketplaceToursForPage(filters),
    queryCatalogSummaryForPage(),
  ]);
  const initial: MarketplaceToursResult | null = toursRes.status === 'fulfilled' ? toursRes.value : null;
  const summary: CatalogSummary | null = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
  for (const [name, r] of [['tours', toursRes], ['summary', summaryRes]] as const) {
    if (r.status === 'rejected') {
      const e = r.reason as { code?: string; message?: string } | undefined;
      console.error('[/marketplace] SSR: запрос ' + name + ' не выполнен', { sqlstate: e?.code, message: e?.message });
    }
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
          summary={summary}
        />
      </Suspense>
      <CatalogFooter />
      {/* Таб-бар с активным «Туры»: пункт объявлен activeOn для этих путей
          (BottomNav.tsx), а страницы его не рендерили — подсветка не
          срабатывала нигде (аудит П5, #56/#62/#98). На md+ он скрыт сам. */}
      <BottomNav activePath="/marketplace" />
    </>
  );
}
