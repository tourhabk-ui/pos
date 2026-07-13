import type { Metadata } from 'next';
import { Suspense } from 'react';
import RoutesPageClient from '../routes/_RoutesPageClient';
import { queryCatalogForPage, type CatalogFilters, type CatalogResult } from '@/lib/routes/catalog-query';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const LIMIT = 24;

export const metadata: Metadata = {
  title: 'Места Камчатки — вулканы, источники, озёра, бухты',
  description:
    'Каталог природных мест Камчатки: вулканы, термальные источники, гейзеры, озёра, бухты, горные реки. Координаты, описания, безопасность, лучшие сезоны для посещения.',
  keywords: [
    'достопримечательности Камчатки',
    'вулканы Камчатки',
    'горячие источники Камчатки',
    'озёра Камчатки',
    'что посмотреть на Камчатке',
  ],
  alternates: { canonical: `${SITE}/places` },
  openGraph: {
    title: 'Места Камчатки',
    description: 'Природные места Камчатки: вулканы, гейзеры, источники, озёра, бухты.',
    url: `${SITE}/places`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Места Камчатки — вулканы, источники, озёра',
    description: 'Каталог природных мест Камчатки: вулканы, гейзеры, озёра, бухты и точки силы.',
  },
};

interface PageProps {
  // Next 15: searchParams — Promise, обязателен await.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * Отдельный раздел «Места» (/places). В отличие от /routes, kind жёстко
 * зафиксирован на 'place' — переключателя на маршруты нет. SSR первого рендера
 * (SEO), клиент — тот же каталог `_RoutesPageClient` с пропом lockedKind.
 */
export default async function PlacesPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const q = first(sp.q).slice(0, 200);
  const locationType = first(sp.location_type).slice(0, 60);
  const pageNumRaw = parseInt(first(sp.page) || '1', 10);
  const page = Number.isFinite(pageNumRaw) && pageNumRaw >= 1 ? pageNumRaw : 1;

  const filters: CatalogFilters = {
    ...(q ? { q } : {}),
    kind: 'place',
    ...(locationType ? { location_type: locationType } : {}),
    page,
    limit: LIMIT,
    sort: 'recommended',
  };

  let initial: CatalogResult | null = null;
  try {
    initial = await queryCatalogForPage(filters);
  } catch {
    initial = null;
  }

  const initialKey = JSON.stringify({
    kind: 'place',
    q,
    activityType: '',
    locationType,
    page,
    sort: 'recommended',
    difficulty: '',
    priceRange: '',
  });

  const itemListJsonLd = initial && initial.items.length > 0
    ? {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: initial.items.map((it, i) => ({
          '@type': 'ListItem',
          position: (page - 1) * LIMIT + i + 1,
          name: it.title,
          url: `${SITE}/places/${it.id}`,
        })),
      }
    : null;

  return (
    <>
      {itemListJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
        />
      )}
      <Suspense>
        <RoutesPageClient
          initialItems={initial?.items ?? []}
          initialMeta={initial ? { total: initial.meta.total, pages: initial.meta.pages } : { total: 0, pages: 1 }}
          initialError={initial === null}
          initialKey={initialKey}
          lockedKind="place"
        />
      </Suspense>
    </>
  );
}
