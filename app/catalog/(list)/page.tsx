/**
 * Список лежит в группе `(list)` вместе со своим `loading.tsx` намеренно.
 * Файл загрузки раздела оборачивает и ВЛОЖЕННЫЕ адреса: пока он стоял в
 * корне раздела, карточка под ним отдавала скелет со статусом 200 раньше, чем
 * успевала сказать «не найдено» или «переехало», — 404 и 308 карточек
 * становились soft-404 и meta-refresh (аудит SEO 29.09, Н2). Группа не
 * меняет адрес, а скелет списка остаётся мгновенным (navigation-loading).
 */
import type { Metadata } from 'next';
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
import { defaultOgImages } from '@/lib/seo/og-image';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Туры на Камчатку — реальные предложения операторов',
  description: 'Честный каталог реальных туров по Камчатке от проверенных операторов. Сначала выбор и проверка деталей, потом заявка оператору.',
  keywords: [
    'туры Камчатка',
    'бронирование туров Камчатка',
    'рыболовные туры Камчатка',
    'восхождение на вулканы Камчатка',
    'термальные источники тур',
  ],
  alternates: {
    canonical: `${SITE}/catalog`,
  },
  openGraph: {
    images: defaultOgImages(),
    title: 'Туры на Камчатку — реальные предложения операторов',
    description: 'Проверенные операторы, реальные предложения и честные условия без серых схем.',
    type: 'website',
    url: `${SITE}/catalog`,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Туры на Камчатку — реальные предложения операторов',
    description: 'Каталог реальных туров от операторов Камчатки с прозрачными условиями.',
  },
};

/**
 * Сервер НЕ читает `searchParams` (аудит 02.10): ожидание этого промиса
 * само по себе делает страницу потоковой — в первом HTML пустой каркас с
 * `<template>`, а туры приезжают отдельным куском, который робот без JS не
 * собирает. Сервер рендерит список по умолчанию, фильтры из адреса применяет
 * клиент после монтирования (`MarketplaceClient`).
 *
 * У /catalog остаётся ВТОРАЯ граница — скелет `loading.tsx` в группе (list):
 * он нужен переходу с таб-бара на медленной сети (navigation-loading, полевой
 * прогон 04.08), и из-за него список по-прежнему уезжает вторым куском. Снять
 * скелет ради роботов без JS — решение владельца, не этой правки; /operators,
 * где скелета нет, отдаёт список в первом HTML. Сторож:
 * tests/unit/list-pages-not-streamed.test.ts.
 */
export default async function CatalogPage() {
  const { filters, initialKey } = parseMarketplaceSearchParams({});

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
      console.error('[/catalog] SSR: запрос ' + name + ' не выполнен', { sqlstate: e?.code, message: e?.message });
    }
  }

  const structuredData = initial ? buildToursItemListJsonLd(initial.tours, SITE, '/catalog') : null;

  return (
    <>
      {structuredData && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      )}
      <Header />
      <MarketplaceClient
        initialTours={initial?.tours ?? []}
        initialTotal={initial?.total ?? 0}
        initialKey={initial === null ? null : initialKey}
        summary={summary}
      />
      <CatalogFooter />
      {/* Таб-бар с активным «Туры»: пункт объявлен activeOn для этих путей
          (BottomNav.tsx), а страницы его не рендерили — подсветка не
          срабатывала нигде (аудит П5, #56/#62/#98). На md+ он скрыт сам. */}
      <BottomNav activePath="/catalog" />
    </>
  );
}
