import type { Metadata } from 'next';
import { Suspense } from 'react';
import RoutesPageClient from '../routes/_RoutesPageClient';
import { queryCatalogForPage, type CatalogFilters, type CatalogResult } from '@/lib/routes/catalog-query';
import { defaultOgImages } from '@/lib/seo/og-image';
import { catalogCanonical, parsePage } from '@/lib/seo/catalog-paging';
import { listActiveParks, type ParkLite } from '@/lib/parks/list';
import { listLiveCategories, type CategoryLink } from '@/lib/routes/live-categories';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const LIMIT = 24;

const BASE_METADATA: Metadata = {
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
    images: defaultOgImages(),
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

/** Страница N — свой canonical и заголовок; см. lib/seo/catalog-paging. */
export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const sp = await searchParams;
  const page = parsePage(first(sp.page));
  const hasFilters = ['q', 'location_type', 'difficulty'].some(k => first(sp[k]) !== '');
  const canonical = catalogCanonical(SITE, '/places', page, hasFilters);
  if (page <= 1 || hasFilters) return { ...BASE_METADATA, alternates: { canonical } };
  const title = `Места Камчатки — страница ${page}`;
  return {
    ...BASE_METADATA,
    title,
    alternates: { canonical },
    openGraph: { ...BASE_METADATA.openGraph, images: defaultOgImages(), title, url: canonical },
  };
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
  // То же, что на /routes: клиент здесь общий, и без чтения сложности с сервера
  // ссылка с ?difficulty= рендерилась бы нефильтрованной, а клиент потом молча
  // перезапрашивал — разный первый экран у поисковика и у человека.
  const difficultyRaw = first(sp.difficulty);
  const difficulty: '' | 'easy' | 'medium' | 'hard' =
    difficultyRaw === 'easy' || difficultyRaw === 'medium' || difficultyRaw === 'hard' ? difficultyRaw : '';
  const page = parsePage(first(sp.page));

  const filters: CatalogFilters = {
    ...(q ? { q } : {}),
    kind: 'place',
    ...(locationType ? { location_type: locationType } : {}),
    ...(difficulty ? { difficulty } : {}),
    page,
    limit: LIMIT,
    sort: 'recommended',
  };

  // Парки — ссылками в первом HTML (аудит 01.10), см. /routes.
  const parksPromise = listActiveParks().catch((err: unknown): ParkLite[] | null => {
    console.error('[places] список парков не прочитан:', err instanceof Error ? err.message : String(err));
    return null;
  });

  // Живые категории — ссылками в первом HTML (аудит 01.10), см. /routes.
  const categoriesPromise = listLiveCategories().catch((err: unknown): CategoryLink[] | null => {
    console.error('[places] категории каталога не прочитаны:', err instanceof Error ? err.message : String(err));
    return null;
  });

  let initial: CatalogResult | null = null;
  try {
    initial = await queryCatalogForPage(filters);
  } catch (err) {
    // Клиент покажет состояние ошибки, но отказ не глушится: без строки в логе
    // пустой первый экран у поисковика неотличим от «мест нет» (§4.0).
    const e = err as { code?: string; message?: string };
    console.error('[places] каталог мест не прочитан', { sqlstate: e?.code, message: e?.message });
    initial = null;
  }

  const initialKey = JSON.stringify({
    kind: 'place',
    q,
    activityType: '',
    locationType,
    page,
    sort: 'recommended',
    difficulty,
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
          initialParks={await parksPromise}
          initialCategories={await categoriesPromise}
        />
      </Suspense>
    </>
  );
}
