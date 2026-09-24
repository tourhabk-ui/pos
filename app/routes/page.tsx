import type { Metadata } from 'next';
import { Suspense } from 'react';
import RoutesPageClient from './_RoutesPageClient';
import { queryCatalogForPage, type CatalogFilters, type CatalogResult } from '@/lib/routes/catalog-query';
import { findToursForQuery } from '@/lib/search/tour-query-match';
import { ToursForQuery, type ToursForQueryState } from '@/components/search/ToursForQuery';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const LIMIT = 24;
/** Сколько туров показать над выдачей мест: три ряда на десктопе. */
const TOURS_LIMIT = 9;

export const metadata: Metadata = {
  title: 'Места Камчатки — вулканы, источники, озёра, бухты',
  description:
    'Каталог природных мест Камчатки: вулканы, термальные источники, гейзеры, озёра, бухты, горные реки. Координаты, описания, лучшие сезоны для посещения.',
  keywords: [
    'достопримечательности Камчатки',
    'вулканы Камчатки',
    'горячие источники Камчатки',
    'маршруты по Камчатке',
    'что посмотреть на Камчатке',
  ],
  alternates: { canonical: `${SITE}/routes` },
  openGraph: {
    title: 'Места Камчатки',
    description: 'Природные места Камчатки: вулканы, гейзеры, источники, озёра, бухты.',
    url: `${SITE}/routes`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Места Камчатки — маршруты и достопримечательности',
    description: 'Каталог природных мест Камчатки: вулканы, гейзеры, озера, бухты и точки силы.',
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
 * SSR первого рендера (шаг 3 аудита 11.07): до этого листинг рендерился
 * только клиентским fetch — Google видел пустой каркас (diag: «Авачинск» 0
 * вхождений в первом HTML при 541 месте в БД). Сервер применяет к первому
 * рендеру те же deep-link-параметры, что читает клиент (kind/q/location_type/
 * activity_type/page), данные кэшируются на 600с в queryCatalogForPage.
 */
export default async function RoutesPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  // По умолчанию — маршруты: адрес говорит /routes, а открывалась вкладка
  // «Места» (#1780). Места — явным ?kind=place (так на них и ссылаются).
  const kindRaw = first(sp.kind);
  const kind: 'place' | 'route' = kindRaw === 'place' ? 'place' : 'route';
  const q = first(sp.q).slice(0, 200);
  const activityType = kind === 'route' ? first(sp.activity_type).slice(0, 60) : '';
  const locationType = kind === 'place' ? first(sp.location_type).slice(0, 60) : '';
  const difficultyRaw = first(sp.difficulty);
  // Сложность живёт в URL с тех пор, как на главной появились чипы подбора
  // («Первый раз» → difficulty=easy). Клиент её и раньше писал в адрес, но
  // ни он, ни сервер не читали обратно — ссылка выглядела рабочей и не была.
  const difficulty: '' | 'easy' | 'medium' | 'hard' =
    difficultyRaw === 'easy' || difficultyRaw === 'medium' || difficultyRaw === 'hard' ? difficultyRaw : '';
  const pageNumRaw = parseInt(first(sp.page) || '1', 10);
  const page = Number.isFinite(pageNumRaw) && pageNumRaw >= 1 ? pageNumRaw : 1;

  // Зеркало initial-состояния клиента: sort и цена в URL по-прежнему не живут.
  const filters: CatalogFilters = {
    ...(q ? { q } : {}),
    kind,
    ...(activityType ? { activity_type: activityType } : {}),
    ...(locationType ? { location_type: locationType } : {}),
    ...(difficulty ? { difficulty } : {}),
    page,
    limit: LIMIT,
    sort: 'recommended',
  };

  /*
   * Туры по запросу (аудит П7, решение владельца 24.09 №9). Поиск героя
   * главной на обоих деревьях ведёт сюда, а выдача ниже знает только места и
   * маршруты — «рыбалка» при семи рыболовных турах в продаже отвечала
   * «Ничего не найдено». Поиск остаётся здесь (места нужны), а туры по тому
   * же q спрашиваются у движка ПОИСК и встают над выдачей. Своего SQL по
   * турам на странице нет. Отказ — состояние `unavailable`, а не пустой
   * список: «туров нет» и «туры не искались» — разные ответы (§4.0).
   */
  const toursPromise: Promise<ToursForQueryState | null> = q.trim()
    ? findToursForQuery(q, TOURS_LIMIT).then(
        (tours): ToursForQueryState => ({
          status: 'ok',
          tours: tours.map(t => ({
            id: t.id,
            title: t.title,
            operator_name: t.operator_name,
            activity_type: t.activity_type,
            base_price: t.base_price,
          })),
        }),
        (err: unknown): ToursForQueryState => {
          console.error('[routes] туры по запросу не найдены из-за отказа:', err instanceof Error ? err.message : String(err));
          return { status: 'unavailable' };
        },
      )
    : Promise.resolve(null);

  let initial: CatalogResult | null = null;
  try {
    initial = await queryCatalogForPage(filters);
  } catch {
    // Честно отдаём клиенту флаг ошибки — он покажет состояние и даст повторить.
    initial = null;
  }
  const toursState = await toursPromise;

  const initialKey = JSON.stringify({
    kind,
    q,
    activityType,
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
          url: `${SITE}${it.kind === 'place' ? '/places/' : '/routes/'}${it.id}`,
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
          toursSlot={toursState ? <ToursForQuery q={q} state={toursState} /> : null}
        />
      </Suspense>
    </>
  );
}
