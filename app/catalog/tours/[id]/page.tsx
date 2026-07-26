import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pool } from '@/lib/db-pool';
import TourDetailClient from '@/app/marketplace/tours/[id]/_TourDetailClient';
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
  try {
    const { rows } = await pool.query(`
      SELECT
        ot.id, ot.title, ot.description, ot.short_description,
        ot.base_price, ot.price_old, ot.price_unit,
        ot.activity_type, ot.location_type,
        ot.location_name, ot.latitude, ot.longitude,
        ot.tour_image, ot.photos,
        ot.max_participants, ot.min_participants,
        ot.duration_hours, ot.duration_type, ot.multi_day_count,
        ot.difficulty,
        ot.included, ot.not_included, ot.what_to_bring,
        ot.season_start, ot.season_end, ot.seasonal_only,
        ot.weather_dependent,
        ot.rating, ot.review_count,
        p.name AS operator_name, p.id AS operator_id
      FROM operator_tours ot
      JOIN partners p ON ot.operator_id = p.id
      WHERE ot.id = $1
        AND ot.is_active = true
        AND ot.deleted_at IS NULL
    `, [id]);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function getReviews(tourId: number) {
  try {
    const { rows } = await pool.query(`
      SELECT id, author_name, author_city, rating, comment, trip_date
      FROM operator_tour_reviews
      WHERE tour_id = $1
      ORDER BY created_at DESC
      LIMIT 6
    `, [tourId]);
    return rows;
  } catch {
    return [];
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const tour = await getTour(parseInt(id));
  if (!tour) return { title: 'Тур не найден | Туры Камчатки' };

  const activityLabel = ACTIVITY_LABELS[tour.activity_type] ?? tour.activity_type;
  const desc = tour.short_description ?? tour.description?.slice(0, 160) ??
    `${activityLabel} на Камчатке. Реальный тур от проверенного оператора.`;

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
    activityLabel: ACTIVITY_LABELS[tour.activity_type] ?? tour.activity_type,
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
