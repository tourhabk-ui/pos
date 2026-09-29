import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { metaDescription } from '@/lib/seo/meta-description';
import { getTourForCard, getTourReviews } from '@/lib/tours/tour-detail-query';
import TourDetailClient from '@/app/marketplace/tours/[id]/_TourDetailClient';
import { buildTourStructuredData } from '@/lib/seo/tour-structured-data';

export const revalidate = 3600;

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

/** Подписи — из единого словаря (lib/tours/labels), своих копий не держим. */
import { activityLabel } from '@/lib/tours/labels';

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
  if (!tour) return { title: 'Тур не найден | Туры Камчатки', robots: { index: false, follow: false } };

  const activity = activityLabel(tour.activity_type);
  // Короткое описание у рыболовных туров — 43–83 знака (аудит SEO 29.09, Н11):
  // сниппет из одной фразы. Добираем из полного описания того же тура, режем
  // по предложению, а не посреди слова. Только данные тура, без сочинённого.
  const short = (tour.short_description ?? '').trim();
  const full = metaDescription([short, tour.description ?? ''].filter(Boolean).join(' '));
  const desc = (short.length >= 110 ? metaDescription(short) : full)
    || `${activity} на Камчатке. Реальный тур от проверенного оператора.`;

  const images = tour.tour_image ? [{ url: tour.tour_image }] : [];

  return {
    title: `${tour.title} | Реальные туры Камчатки`,
    description: desc,
    alternates: { canonical: `${SITE}/catalog/tours/${tour.id}` },
    openGraph: {
      title: tour.title,
      description: desc,
      images,
      type: 'website',
      url: `${SITE}/catalog/tours/${tour.id}`,
    },
  };
}

export default async function CatalogTourDetailPage({ params }: Props) {
  const { id } = await params;
  const tourId = parseInt(id);
  if (isNaN(tourId)) notFound();

  const [tour, reviews] = await Promise.all([getTour(tourId), getReviews(tourId)]);
  if (!tour) notFound();

  const structuredData = buildTourStructuredData(tour, reviews, {
    canonicalUrl: `${SITE}/catalog/tours/${tour.id}`,
    siteUrl: SITE,
    activityLabel: activityLabel(tour.activity_type),
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <TourDetailClient tour={tour} reviews={reviews} />
    </>
  );
}
