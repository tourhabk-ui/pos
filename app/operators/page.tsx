import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import OperatorsPageClient from '@/app/marketplace/operators/_OperatorsClient';
import { queryOperatorsForPage, type OperatorsFilters, type OperatorsResult } from '@/lib/operators/list-query';
import { defaultOgImages } from '@/lib/seo/og-image';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const LIMIT = 12;

// Сборка Docker идёт без БД (Dockerfile): статический пререндер запёк бы
// пустой список. Страница динамическая, данные кэширует data-слой (600 с).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Операторы Камчатки — туры, рыбалка, треккинг, вертолёты',
  description:
    'Проверенные туристические операторы Камчатки. Рыболовные туры, треккинг к вулканам, вертолётные экскурсии, медвежье сафари — выбирайте лицензированных профессионалов.',
  alternates: { canonical: `${SITE}/operators` },
  openGraph: {
    images: defaultOgImages(),
    title: 'Операторы Камчатки',
    description: 'Проверенные туроператоры Камчатки — от рыбалки до вулканов.',
    url: `${SITE}/operators`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

/**
 * SSR первого рендера (шаг 3 аудита 11.07): до этого листинг операторов
 * рендерился только клиентским fetch — в первом HTML не было ни одной
 * карточки.
 *
 * Сервер НЕ читает `searchParams` (аудит 02.10): ожидание этого промиса
 * делает страницу потоковой — в первом HTML остаётся пустая `<main>` с
 * `<template>`, а список приезжает отдельным куском, который робот без JS не
 * собирает (/articles, где промиса нет, отдавал список целиком; /operators,
 * /catalog — ноль слов). Поэтому сервер всегда рендерит список по умолчанию
 * (страница 1, без фильтров), а фильтры из адреса применяет клиент после
 * монтирования (`OperatorsPageClient`). Сторож:
 * tests/unit/list-pages-not-streamed.test.ts.
 */
export default async function OperatorsPage() {
  const search = '';
  const category = '';
  const page = 1;
  const filters: OperatorsFilters = { page, limit: LIMIT };

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
        <OperatorsPageClient
          initialItems={initial?.items ?? []}
          initialMeta={initial?.meta ?? null}
          initialKey={initialKey}
        />
      </main>
      <Footer />
    </div>
  );
}
