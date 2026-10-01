/**
 * Список лежит в группе `(list)` вместе со своим `loading.tsx` намеренно.
 * Файл загрузки раздела оборачивает и ВЛОЖЕННЫЕ адреса: пока он стоял в
 * корне раздела, карточка под ним отдавала скелет со статусом 200 раньше, чем
 * успевала сказать «не найдено» или «переехало», — 404 и 308 карточек
 * становились soft-404 и meta-refresh (аудит SEO 29.09, Н2). Группа не
 * меняет адрес, а скелет списка остаётся мгновенным (navigation-loading).
 */
import type { Metadata } from 'next';
import { Suspense } from 'react';
import RoutesPageClient from '../_RoutesPageClient';
import { queryCatalogForPage, type CatalogFilters, type CatalogResult } from '@/lib/routes/catalog-query';
import { findToursForQuery } from '@/lib/search/tour-query-match';
import { ToursForQuery, type ToursForQueryState } from '@/components/search/ToursForQuery';
import { defaultOgImages } from '@/lib/seo/og-image';
import { catalogCanonical, parsePage } from '@/lib/seo/catalog-paging';
import { listActiveParks, type ParkLite } from '@/lib/parks/list';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const LIMIT = 24;
/** Сколько туров показать над выдачей мест: три ряда на десктопе. */
const TOURS_LIMIT = 9;

// С #1780 адрес открывает МАРШРУТЫ, а заголовок остался от мест: title и
// описание совпадали с /places дословно — две страницы соперничали за один
// запрос, и ни одна не отвечала «маршруты» (аудит SEO 29.09, вечер).
// Сторож: tests/unit/seo-audit-2909-evening.test.ts.
const BASE_METADATA: Metadata = {
  title: 'Маршруты по Камчатке — к вулканам, источникам и озёрам',
  description:
    'Маршруты по Камчатке: пешие и автомобильные пути к вулканам, термальным источникам и озёрам. Точки пути, сложность, сезон и опасности на маршруте.',
  keywords: [
    'маршруты по Камчатке',
    'треккинг Камчатка',
    'восхождение на вулкан Камчатка',
    'походы по Камчатке',
    'что посмотреть на Камчатке',
  ],
  alternates: { canonical: `${SITE}/routes` },
  openGraph: {
    images: defaultOgImages(),
    title: 'Маршруты по Камчатке',
    description: 'Пешие и автомобильные маршруты к вулканам, источникам и озёрам Камчатки.',
    url: `${SITE}/routes`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Маршруты по Камчатке — к вулканам, источникам и озёрам',
    description: 'Пешие и автомобильные маршруты к вулканам, источникам и озёрам Камчатки.',
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
 * Страница каталога N — своя страница со своим canonical и заголовком
 * (аудит 01.10): с canonical на первую поисковик выбрасывал вторую и
 * дальше как дубль, а вместе с ними ссылки на их карточки. Вкладка мест
 * (`?kind=place`) — дубль раздела /places, canonical туда.
 */
export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const sp = await searchParams;
  const page = parsePage(first(sp.page));
  const isPlaces = first(sp.kind) === 'place';
  const hasFilters = ['q', 'activity_type', 'location_type', 'difficulty'].some(k => first(sp[k]) !== '');
  const canonical = catalogCanonical(SITE, isPlaces ? '/places' : '/routes', page, hasFilters);
  if (page <= 1 || hasFilters) return { ...BASE_METADATA, alternates: { canonical } };
  const title = `Маршруты по Камчатке — страница ${page}`;
  return {
    ...BASE_METADATA,
    title,
    alternates: { canonical },
    openGraph: { ...BASE_METADATA.openGraph, images: defaultOgImages(), title, url: canonical },
  };
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
  const page = parsePage(first(sp.page));

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
            slug: t.slug,
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

  // Парки — ссылками в первом HTML: полоса собиралась в браузере, и шесть
  // карточек парков не были достижимы обходом ни с одной страницы (аудит 01.10).
  const parksPromise = listActiveParks().catch((err: unknown): ParkLite[] | null => {
    console.error('[routes] список парков не прочитан:', err instanceof Error ? err.message : String(err));
    return null;
  });

  let initial: CatalogResult | null = null;
  try {
    initial = await queryCatalogForPage(filters);
  } catch (err) {
    // Честно отдаём клиенту флаг ошибки — он покажет состояние и даст повторить.
    // Отказ не глушится: имя и SQLSTATE — в лог (§4.0).
    const e = err as { code?: string; message?: string };
    console.error('[routes] каталог маршрутов не прочитан', { sqlstate: e?.code, message: e?.message });
    initial = null;
  }
  const toursState = await toursPromise;
  const parks = await parksPromise;

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
          initialParks={parks}
          toursSlot={toursState ? <ToursForQuery q={q} state={toursState} /> : null}
        />
      </Suspense>
    </>
  );
}
