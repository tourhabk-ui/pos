import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { loadTourCard, getTourReviews } from '@/lib/tours/tour-detail-query';
import { tourPath } from '@/lib/tours/tour-url';
import TourDetailClient from './_TourDetailClient';
import { buildTourStructuredData } from '@/lib/seo/tour-structured-data';

export const revalidate = 3600;

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

/** Подписи — из единого словаря (lib/tours/labels), своих копий не держим. */
import { activityLabel } from '@/lib/tours/labels';
import { tourHeroImage } from '@/lib/tours/hero-image';

interface Props {
  params: Promise<{ id: string }>;
}


async function getReviews(tourId: number) {
  return getTourReviews(tourId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const tour = (await loadTourCard(id))?.tour;
  if (!tour) return { title: 'Тур не найден | Туры Камчатки' };

  const activity = activityLabel(tour.activity_type);
  const desc = tour.short_description ?? tour.description?.slice(0, 160) ??
    `${activity} на Камчатке. Реальный тур от проверенного оператора с уточнением деталей перед бронированием.`;

  const hero = tourHeroImage(tour.photos, tour.tour_image);
  const images = hero ? [{ url: hero }] : [];

  return {
    title: `${tour.title} | Реальные туры Камчатки`,
    description: desc,
    // Канон — /catalog/tours/[id]: карточка живёт по двум адресам, но sitemap
    // и навигация подают каталог. Самоссылающийся canonical здесь делил
    // сигналы тура между двумя URL.
    alternates: { canonical: `${SITE}${tourPath(tour)}` },
    openGraph: {
      title: tour.title,
      description: desc,
      images,
      type: 'website',
      url: `${SITE}${tourPath(tour)}`,
    },
  };
}

export default async function TourDetailPage({ params }: Props) {
  const { id } = await params;
  const loaded = await loadTourCard(id);
  if (!loaded) notFound();
  const { tour } = loaded;
  // Пришли по числу, а у тура есть адрес — 308 на адрес: в выдаче и у
  // людей должен жить один адрес карточки (ЧПУ туров, 30.09).
  if (loaded.byId && tour.slug) permanentRedirect(tourPath(tour));
  const reviews = await getReviews(tour.id);

  const structuredData = buildTourStructuredData(tour, reviews, {
    canonicalUrl: `${SITE}${tourPath(tour)}`,
    siteUrl: SITE,
    activityLabel: activityLabel(tour.activity_type),
  });

  return (
    <>
      {structuredData && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      )}
      <TourDetailClient tour={tour} reviews={reviews} />
    </>
  );
}
