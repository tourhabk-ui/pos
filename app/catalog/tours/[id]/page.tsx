import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { metaDescription } from '@/lib/seo/meta-description';
import { loadTourCard, getTourReviews } from '@/lib/tours/tour-detail-query';
import { tourPath } from '@/lib/tours/tour-url';
import { reachForTour } from '@/lib/partners/reach';
import TourDetailClient from './_TourDetailClient';
import { buildTourStructuredData } from '@/lib/seo/tour-structured-data';
import { tourHeroImage } from '@/lib/tours/hero-image';
import { countTourDates, availabilityFromDates } from '@/lib/tours/open-dates';

export const revalidate = 3600;

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

/** Подписи — из единого словаря (lib/tours/labels), своих копий не держим. */
import { activityLabel } from '@/lib/tours/labels';

interface Props {
  params: Promise<{ id: string }>;
}


async function getReviews(tourId: number) {
  return getTourReviews(tourId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const tour = (await loadTourCard(id))?.tour;
  if (!tour) return { title: 'Тур не найден | Туры Камчатки', robots: { index: false, follow: false } };

  const activity = activityLabel(tour.activity_type);
  // Короткое описание у рыболовных туров — 43–83 знака (аудит SEO 29.09, Н11):
  // сниппет из одной фразы. Добираем из полного описания того же тура, режем
  // по предложению, а не посреди слова. Только данные тура, без сочинённого.
  const short = (tour.short_description ?? '').trim();
  const full = metaDescription([short, tour.description ?? ''].filter(Boolean).join(' '));
  const desc = (short.length >= 110 ? metaDescription(short) : full)
    || `${activity} на Камчатке. Реальный тур от проверенного оператора.`;

  // Кадр для OG — по общему правилу (обложка раньше галереи). До 02.10 это
  // правило стояло только в мёртвой копии страницы под /marketplace, а живая
  // страница брала tour_image напрямую: ровно та болезнь двух карточек (§11).
  const hero = tourHeroImage(tour.photos, tour.tour_image);
  const images = hero ? [{ url: hero }] : [];

  return {
    title: `${tour.title} | Реальные туры Камчатки`,
    description: desc,
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

export default async function CatalogTourDetailPage({ params }: Props) {
  const { id } = await params;
  const loaded = await loadTourCard(id);
  if (!loaded) notFound();
  const { tour } = loaded;
  // Пришли по числу, а у тура есть адрес — 308 на адрес: в выдаче и у
  // людей должен жить один адрес карточки (ЧПУ туров, 30.09).
  if (loaded.byId && tour.slug) permanentRedirect(tourPath(tour));
  const [reviews, dates, reach] = await Promise.all([getReviews(tour.id), countTourDates(tour.id), reachForTour(tour.id)]);
  // Расписания нет, а оператору есть куда написать — первым путём на карточке
  // идёт запрос мест (04.10). «Не смог прочитать» (null) — не повод менять
  // путь: остаётся обычная заявка.
  const askSeatsFirst = dates?.recorded === 0 && reach?.reachable === true;

  const structuredData = buildTourStructuredData(tour, reviews, {
    canonicalUrl: `${SITE}${tourPath(tour)}`,
    siteUrl: SITE,
    activityLabel: activityLabel(tour.activity_type),
    availability: availabilityFromDates(dates),
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <TourDetailClient tour={tour} reviews={reviews} askSeatsFirst={askSeatsFirst} />
    </>
  );
}
