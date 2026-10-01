import type { Metadata } from 'next';
import { pool } from '@/lib/db-pool';
import { FishingPageClient } from './_FishingPageClient';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import { tourPath } from '@/lib/tours/tour-url';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Рыбалка на Камчатке — туры от профессионалов',
  description: 'Рыболовные туры на Камчатке: лосось, кижуч, чавыча, нерка. Зимняя и летняя рыбалка на реке Камчатка с проверенными операторами. Заявка онлайн.',
  keywords: ['рыбалка Камчатка', 'рыболовные туры Камчатка', 'рыбалка на лосося', 'рыбалка на реке Камчатка', 'рыбалка тур'],
  // Посадочная «Рыбалка» из шапки сайта и главной. Родительский /hub/layout
  // ставит noindex всему кабинету — и эта публичная страница молча выпадала
  // из поиска, хотя robots.txt её явно открывал (аудит SEO 29.09, Н13).
  robots: { index: true, follow: true },
  alternates: { canonical: '/hub/fishing' },
  // Без картинки ссылка на посадочную уходила в мессенджеры голой (аудит
  // SEO 29.09, вечер). Снимок — тот же, что у категории «Рыбалка» в каталоге.
  openGraph: {
    url: '/hub/fishing',
    title: 'Рыбалка на Камчатке — туры от профессионалов',
    description: 'Лосось, кижуч, чавыча — рыбалка на реке Камчатка с профессиональными гидами.',
    type: 'website',
    images: [{ url: '/images/activities/fishing.jpg', width: 1680, height: 1141, alt: 'Рыбалка на Камчатке' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Рыбалка на Камчатке — туры от профессионалов',
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
  operator_slug: string;
}

async function getFishingTours(): Promise<FishingTour[]> {
  const { rows } = await pool.query<FishingTour>(`
    SELECT
      ot.id, ot.slug, ot.title, ot.short_description, ot.description,
      ot.base_price::float, ot.duration_hours::float,
      ot.max_participants, ot.min_participants,
      ot.difficulty, ot.photos, ot.included,
      ot.season_start::text, ot.season_end::text,
      p.name AS operator_name, p.slug AS operator_slug
    FROM operator_tours ot
    JOIN partners p ON p.id = ot.operator_id
    WHERE ot.activity_type = 'fishing'
      AND ot.is_active  = true
      AND ot.is_published = true
      AND ot.deleted_at IS NULL
    ORDER BY ot.base_price ASC
  `);
  return rows;
}

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export default async function FishingPage() {
  const tours = await getFishingTours();

  // Schema.org structured data — индексируется Яндексом, Google, Алисой
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Рыболовные туры на Камчатке',
    description: 'Рыбалка на реке Камчатка: лосось, кижуч, чавыча, нерка. Профессиональные гиды.',
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
        provider: {
          '@type': 'TouristInformationCenter',
          name: t.operator_name,
          url: `${SITE}/operators/${t.operator_slug}`,
        },
        offers: {
          '@type': 'Offer',
          price: t.base_price,
          priceCurrency: 'RUB',
          // availability не объявляется: даты здесь не считались, а «в наличии»
          // у тура без свободных дат — обещание выдачи, которого нет (аудит 01.10).
          // Честный ответ по датам — на карточке тура (lib/tours/open-dates).
          url: `${SITE}${tourPath(t)}`,
        },
        ...(t.duration_hours && {
          itinerary: {
            '@type': 'ItemList',
            numberOfItems: 1,
            description: `Продолжительность: ${Math.round(t.duration_hours / 24)} дн.`,
          },
        }),
        ...(t.photos?.[0] && {
          image: t.photos[0],
        }),
      },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      {/* Шапка (с SOS, §2) и таб-бар: до 29.09 публичная посадочная «Рыбалка»
          была тупиком без навигации и без SOS (аудит UI/UX 29.09, P0). */}
      <Header />
      <div className="px-4 pt-20 pb-24 md:pb-10">
        <FishingPageClient tours={tours} />
      </div>
      <BottomNav activePath="/hub/fishing" />
    </>
  );
}
