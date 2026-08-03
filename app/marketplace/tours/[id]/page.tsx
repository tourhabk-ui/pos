import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTourForCard, getTourReviews } from '@/lib/tours/tour-detail-query';
import TourDetailClient from './_TourDetailClient';
import { buildTourStructuredData } from '@/lib/seo/tour-structured-data';

export const revalidate = 3600;

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

const ACTIVITY_LABELS: Record<string, string> = {
  trekking:   'Треккинг',
  fishing:    'Рыбалка',
  thermal:    'Термальные источники',
  helicopter: 'Вертолётные туры',
  boat_trip:  'Морские туры',
  bears:      'Наблюдение за медведями',
  rafting:    'Сплав',
  snowmobile: 'Снегоходные туры',
};

interface Props {
  params: Promise<{ id: string }>;
}

async function getTour(id: number) {
  return getTourForCard(id);
}

async function getReviews(tourId: number) {
  return getTourReviews(tourId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const tour = await getTour(parseInt(id));
  if (!tour) return { title: 'Тур не найден | Туры Камчатки' };

  const activityLabel = ACTIVITY_LABELS[tour.activity_type] ?? tour.activity_type;
  const desc = tour.short_description ?? tour.description?.slice(0, 160) ??
    `${activityLabel} на Камчатке. Реальный тур от проверенного оператора с уточнением деталей перед бронированием.`;

  const images = tour.tour_image ? [{ url: tour.tour_image }] : [];

  return {
    title: `${tour.title} | Реальные туры Камчатки`,
    description: desc,
    alternates: { canonical: `${SITE}/marketplace/tours/${tour.id}` },
    openGraph: {
      title: tour.title,
      description: desc,
      images,
      type: 'website',
      url: `${SITE}/marketplace/tours/${tour.id}`,
    },
  };
}

export default async function TourDetailPage({ params }: Props) {
  const { id } = await params;
  const tourId = parseInt(id);
  if (isNaN(tourId)) notFound();

  const [tour, reviews] = await Promise.all([getTour(tourId), getReviews(tourId)]);
  if (!tour) notFound();

  const structuredData = buildTourStructuredData(tour, reviews, {
    canonicalUrl: `${SITE}/marketplace/tours/${tour.id}`,
    siteUrl: SITE,
    activityLabel: ACTIVITY_LABELS[tour.activity_type] ?? tour.activity_type,
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
