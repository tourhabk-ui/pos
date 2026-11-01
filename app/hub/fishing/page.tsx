import type { Metadata } from 'next';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { orderOffersBy } from '@/lib/tours/offer-order';
import { FishingPageClient } from './_FishingPageClient';
import { FishingGuide, fishingFaqJsonLd } from './_FishingGuide';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import { tourPath } from '@/lib/tours/tour-url';
import { operatorPagePath } from '@/lib/operators/page-link';
import { absolutePhotoUrls } from '@/lib/notifications/photo-urls';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Рыбалка на Камчатке 2026 — туры, цены, сезоны',
  description: 'Рыболовные туры на Камчатке 2026: цены операторов, сезоны чавычи, нерки, кеты и кижуча, зимняя рыбалка. Заявка оператору напрямую, без комиссии.',
  keywords: ['рыбалка Камчатка тур', 'рыбалка на Камчатке 2026', 'рыбалка Камчатка', 'рыболовные туры Камчатка', 'рыбалка на лосося', 'рыбалка на реке Камчатка', 'рыбалка тур'],
  // Посадочная «Рыбалка» из шапки сайта и главной. Родительский /hub/layout
  // ставит noindex всему кабинету — и эта публичная страница молча выпадала
  // из поиска, хотя robots.txt её явно открывал (аудит SEO 29.09, Н13).
  robots: { index: true, follow: true },
  alternates: { canonical: '/hub/fishing' },
  // Без картинки ссылка на посадочную уходила в мессенджеры голой (аудит
  // SEO 29.09, вечер). Снимок — тот же, что у категории «Рыбалка» в каталоге.
  openGraph: {
    url: '/hub/fishing',
    title: 'Рыбалка на Камчатке 2026 — туры, цены, сезоны',
    description: 'Лосось, кижуч, чавыча — рыбалка на реке Камчатка с профессиональными гидами.',
    type: 'website',
    images: [{ url: '/images/activities/fishing.jpg', width: 1680, height: 1141, alt: 'Рыбалка на Камчатке' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Рыбалка на Камчатке 2026 — туры, цены, сезоны',
    images: ['/images/activities/fishing.jpg'],
  },
};

interface FishingTour {
  id: number;
  slug: string | null;
  title: string;
  short_description: string | null;
  description: string | null;
  base_price: number;
  duration_hours: number;
  max_participants: number;
  min_participants: number;
  difficulty: string | null;
  photos: string[];
  included: unknown;
  season_start: string | null;
  season_end: string | null;
  operator_name: string;
  /** partners.slug / partners.is_public — страница оператора; закрыта или без адреса — имя текстом (13.10). */
  operator_slug: string | null;
  operator_public: boolean | null;
  /** Ближайшая дата со свободными местами ('YYYY-MM-DD'); нет — null. Ключ правила 1в. */
  nearest_free_date?: string | null;
}

/**
 * Три исхода (§4.0): туры прочитаны / туров нет / база не ответила. До 29.10
 * отказ пула (issue #2579: «timeout exceeded when trying to connect», 72 за
 * сутки) ронял всю страницу в 500 через error.tsx, хотя текст и навигация от
 * базы не зависят. Теперь страница открывается, а список честно говорит
 * «не загрузился» — как /operators и /places/[id] (#2648), не «туров нет».
 */
type FishingToursRead = { kind: 'ok'; tours: FishingTour[] } | { kind: 'failed' };

async function getFishingTours(): Promise<FishingToursRead> {
  try {
    const { rows } = await pool.query<FishingTour>(`
    SELECT
      ot.id, ot.slug, ot.title, ot.short_description, ot.description,
      ot.base_price::float, ot.duration_hours::float,
      ot.max_participants, ot.min_participants,
      ot.difficulty, ot.photos, ot.included,
      ot.season_start::text, ot.season_end::text,
      p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public,
      ${nearestFreeDateSql('ot')} AS nearest_free_date
    FROM operator_tours ot
    JOIN partners p ON p.id = ot.operator_id
    WHERE ot.activity_type = 'fishing'
      AND ${publicTourSql('ot')}
  `);
    // Порядок — правило 1в (слово владельца 29.10), а не «дешевле выше».
    return { kind: 'ok', tours: orderOffersBy(rows, (r) => ({ id: String(r.id), nearestFreeDate: r.nearest_free_date ?? null })) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[fishing] туры на рыбалку не прочитаны:', `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return { kind: 'failed' };
  }
}

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

/** Адрес страницы оператора для разметки — только у открытой карточки (13.10): ссылка на 404 хуже её отсутствия. */
function operatorUrl(t: Pick<FishingTour, 'operator_slug' | 'operator_public'>): string | undefined {
  const path = operatorPagePath({ slug: t.operator_slug, is_public: t.operator_public });
  return path ? `${SITE}${path}` : undefined;
}

/**
 * Оператор в разметке — организация, как у карточки тура (аудит 01.10,
 * operatorOrganization). Здесь оставался `TouristInformationCenter`: так
 * поисковик видит не того, кто проводит тур, а «справочное бюро». Открыта
 * страница оператора — адрес и тот же `@id`, что она объявляет у себя.
 */
/** Первый снимок тура абсолютным адресом (одно правило с постами тура) или undefined. */
function firstPhoto(t: Pick<FishingTour, 'photos'>): string | undefined {
  return absolutePhotoUrls(t.photos, SITE)[0];
}

function operatorProvider(t: Pick<FishingTour, 'operator_name' | 'operator_slug' | 'operator_public'>): Record<string, unknown> {
  const url = operatorUrl(t);
  return url
    ? { '@type': 'Organization', '@id': `${url}#organization`, name: t.operator_name, url }
    : { '@type': 'Organization', name: t.operator_name };
}

export default async function FishingPage() {
  const read = await getFishingTours();
  const tours = read.kind === 'ok' ? read.tours : [];

  // Schema.org structured data — индексируется Яндексом, Google, Алисой.
  // При отказе базы разметки нет: «numberOfItems: 0» было бы ложью о витрине.
  const structuredData = read.kind === 'failed' ? null : {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Рыболовные туры на Камчатке',
    description: 'Рыболовные туры на Камчатке: лосось, кижуч, чавыча, нерка — цена, программа и заявка оператору.',
    url: `${SITE}/hub/fishing`,
    numberOfItems: tours.length,
    itemListElement: tours.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'TouristTrip',
        // Адрес тура — /catalog/tours/{id}. Прежний /hub/marketplace/{id}
        // не существует: аноним получал редирект на вход, обходчик — адрес
        // под Disallow: /hub/ (сверка SEO 29.09, вечер).
        '@id': `${SITE}${tourPath(t)}`,
        name: t.title,
        description: t.short_description ?? t.description ?? '',
        url: `${SITE}${tourPath(t)}`,
        touristType: 'Рыбаки, любители активного отдыха',
        availableLanguage: 'Russian',
        provider: operatorProvider(t),
        offers: {
          '@type': 'Offer',
          price: t.base_price,
          priceCurrency: 'RUB',
          // availability не объявляется: даты здесь не считались, а «в наличии»
          // у тура без свободных дат — обещание выдачи, которого нет (аудит 01.10).
          // Честный ответ по датам — на карточке тура (lib/tours/open-dates).
          url: `${SITE}${tourPath(t)}`,
        },
        // Снимок — абсолютным адресом: относительный путь поисковик в разметке
        // не разрешает (перепись 13.10, прогон 6). Длительность здесь больше не
        // объявляется: «Продолжительность: N дн.» считалась округлением часов до
        // суток и у дневного выезда на 8 часов давала «0 дн.». Честная
        // длительность — на карточке тура.
        ...(firstPhoto(t) && { image: firstPhoto(t) }),
      },
    })),
  };

  return (
    <>
      {structuredData && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      )}
      {structuredData && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(fishingFaqJsonLd()) }} />
      )}
      {/* Шапка (с SOS, §2) и таб-бар: до 29.09 публичная посадочная «Рыбалка»
          была тупиком без навигации и без SOS (аудит UI/UX 29.09, P0). */}
      <Header />
      <div className="px-4 pt-20 pb-24 md:pb-10">
        <FishingPageClient tours={tours} failed={read.kind === 'failed'} />
        <FishingGuide />
      </div>
      <BottomNav activePath="/hub/fishing" />
    </>
  );
}
