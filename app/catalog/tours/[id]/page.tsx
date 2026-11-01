import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { metaDescription } from '@/lib/seo/meta-description';
import { brandedTitle, fitTitleRequired, TOUR_TITLE_TAILS } from '@/lib/seo/title-fit';
import { loadTourCard, getTourReviews } from '@/lib/tours/tour-detail-query';
import { tourPath } from '@/lib/tours/tour-url';
import { reachForTour } from '@/lib/partners/reach';
import TourDetailClient from './_TourDetailClient';
import { buildTourStructuredData } from '@/lib/seo/tour-structured-data';
import { tourHeroImage } from '@/lib/tours/hero-image';
import { countTourDates, availabilityFromDates } from '@/lib/tours/open-dates';
import { requestWindow, seasonWindowView } from '@/lib/tours/request-window';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { zhTourAlternatePath } from '@/lib/zh/content';
import { loadPlaceOffersForTour } from '@/lib/places/place-tours';
import { splitPrefillId } from '@/lib/booking/request-prefill';

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
  if (!tour) return { title: 'Тур не найден', robots: { index: false, follow: false } };

  const activity = activityLabel(tour.activity_type);
  // Короткое описание у рыболовных туров — 43–83 знака (аудит SEO 29.09, Н11):
  // сниппет из одной фразы. Добираем из полного описания того же тура, режем
  // по предложению, а не посреди слова. Только данные тура, без сочинённого.
  const short = (tour.short_description ?? '').trim();
  const full = metaDescription([short, tour.description ?? ''].filter(Boolean).join(' '));
  // Запас без описаний — только из данных тура: «проверенного» лишь при
  // partners.is_verified = true, как отметка на самой карточке (аудит П6, #138).
  const byOperator = tour.operator_name
    ? `: тур ${tour.operator_verified === true ? 'проверенного оператора' : 'оператора'} ${tour.operator_name}`
    : '';
  const desc = (short.length >= 110 ? metaDescription(short) : full)
    || `${activity} на Камчатке${byOperator}. Программа, цена и заявка оператору на Ведаре.`;

  // Кадр для OG — по общему правилу (обложка раньше галереи). До 02.10 это
  // правило стояло только в мёртвой копии страницы под /marketplace, а живая
  // страница брала tour_image напрямую: ровно та болезнь двух карточек (§11).
  const hero = tourHeroImage(tour.photos, tour.tour_image);
  const images = hero ? [{ url: hero }] : [];

  // Пара ru ↔ zh-CN есть у каждого живого тура: китайская страница — факты
  // из базы, проза без перевода туда не кладётся (lib/zh/content).
  const zh = await zhTourAlternatePath(tour);

  return {
    title: brandedTitle(fitTitleRequired(tour.title, TOUR_TITLE_TAILS)),
    description: desc,
    alternates: {
      canonical: `${SITE}${tourPath(tour)}`,
      ...(zh ? { languages: { ru: `${SITE}${tourPath(tour)}`, 'zh-CN': `${SITE}${zh}` } } : {}),
    },
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
  const { id: rawId } = await params;
  // Предзаполнение формы из ?date=/?guests= приходит только от динамического
  // двойника request/page.tsx (rewrite в next.config.js) как «<id>~<query>»:
  // сам ISR-маршрут адрес не читает и из кэша не выпадает.
  const { id, prefill } = splitPrefillId(rawId);
  const loaded = await loadTourCard(id);
  if (!loaded) notFound();
  const { tour } = loaded;
  // Пришли по числу, а у тура есть адрес — 308 на адрес: в выдаче и у
  // людей должен жить один адрес карточки (ЧПУ туров, 30.09).
  if (loaded.byId && tour.slug) permanentRedirect(tourPath(tour));
  // «К месту ещё N предложений» (слово владельца 29.10, «3 да») — по записанной
  // связи тура с местом; отказ загрузчик пишет в лог, строки тогда нет.
  const [reviews, dates, reach, placeOffers] = await Promise.all([
    getReviews(tour.id), countTourDates(tour.id), reachForTour(tour.id),
    loadPlaceOffersForTour({ id: tour.id, main_place_id: tour.main_place_id }),
  ]);
  // Расписания нет, а оператору есть куда написать — первым путём на карточке
  // идёт запрос мест (04.10). «Не смог прочитать» (null) — не повод менять
  // путь: остаётся обычная заявка.
  const askSeatsFirst = dates?.recorded === 0 && reach?.reachable === true;
  // Даты без календаря — только по сезону (#2244, #2245): та же граница, что
  // у брони и запроса мест на сервере, — форма не даёт выбрать то, что
  // сервер отвергнет.
  const seasonWindow = seasonWindowView(requestWindow({
    season_start: tour.season_start, season_end: tour.season_end,
    duration_type: tour.duration_type, multi_day_count: tour.multi_day_count,
    duration_hours: tour.duration_hours == null ? null : Number(tour.duration_hours),
  }, kamchatkaToday()));

  const structuredData = buildTourStructuredData(tour, reviews, {
    canonicalUrl: `${SITE}${tourPath(tour)}`,
    siteUrl: SITE,
    activityLabel: activityLabel(tour.activity_type),
    availability: availabilityFromDates(dates),
  });
  // Заявка как действие для агентов (schema.org ReserveAction): запрос
  // оператору, не мгновенная бронь.
  (structuredData as Record<string, unknown>).potentialAction = {
    '@type': 'ReserveAction',
    name: 'Оставить заявку на тур (оператор подтвердит)',
    target: {
      '@type': 'EntryPoint',
      urlTemplate: `${SITE}${tourPath(tour)}?date={date}&guests={guests}#booking`,
      actionPlatform: ['https://schema.org/DesktopWebPlatform', 'https://schema.org/MobileWebPlatform'],
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <TourDetailClient prefill={prefill} tour={tour} reviews={reviews} askSeatsFirst={askSeatsFirst} seasonWindow={seasonWindow} placeOffers={placeOffers} />
    </>
  );
}
