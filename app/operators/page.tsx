import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import OperatorsPageClient from '@/app/marketplace/operators/_OperatorsClient';
import { queryOperatorsForPage, type OperatorsFilters, type OperatorsResult } from '@/lib/operators/list-query';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const LIMIT = 12;

export const metadata: Metadata = {
  title: 'Операторы Камчатки — туры, рыбалка, треккинг, вертолёты',
  description:
    'Проверенные туристические операторы Камчатки. Рыболовные туры, треккинг к вулканам, вертолётные экскурсии, медвежье сафари — выбирайте лицензированных профессионалов.',
  alternates: { canonical: `${SITE}/operators` },
  openGraph: {
    title: 'Операторы Камчатки',
    description: 'Проверенные туроператоры Камчатки — от рыбалки до вулканов.',
    url: `${SITE}/operators`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
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
 * SSR первого рендера (шаг 3 аудита 11.07): до этого листинг операторов
 * рендерился только клиентским fetch — в первом HTML не было ни одной
 * карточки. Сервер применяет те же deep-link-параметры, что читает клиент
 * (search/category/page), данные кэшируются на 600с.
 */
export default async function OperatorsPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const search = first(sp.search).slice(0, 200);
  const category = first(sp.category).slice(0, 60);
  const pageNumRaw = parseInt(first(sp.page) || '1', 10);
  const page = Number.isFinite(pageNumRaw) && pageNumRaw >= 1 ? pageNumRaw : 1;

  const filters: OperatorsFilters = {
    ...(search ? { search } : {}),
    ...(category ? { category } : {}),
    page,
    limit: LIMIT,
  };

  let initial: OperatorsResult | null = null;
  try {
    initial = await queryOperatorsForPage(filters);
  } catch {
    initial = null;
  }

  const initialKey = initial === null ? null : JSON.stringify({ search, category, page });

  const itemListJsonLd = initial && initial.items.length > 0
    ? {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: initial.items.map((op, i) => ({
          '@type': 'ListItem',
          position: (page - 1) * LIMIT + i + 1,
          name: op.name,
          url: `${SITE}/operators/${op.slug}`,
        })),
      }
    : null;

  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      {itemListJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
        />
      )}
      <Header />
      <main className="pt-16">
        <Suspense>
          <OperatorsPageClient
            initialItems={initial?.items ?? []}
            initialMeta={initial?.meta ?? null}
            initialKey={initialKey}
          />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
