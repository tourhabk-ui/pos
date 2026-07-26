/**
 * JSON-LD для страниц туров. Раньше отдавался только `TouristTrip` — семантически
 * верно, но Google рисует rich-сниппет (звёзды рейтинга + цена) для типа
 * `Product`, а `TouristTrip` в список eligible-типов не входит. Поэтому отдаём
 * `@graph` с ДВУМЯ узлами: `Product` (под сниппет Google — бронируемый тур =
 * продукт) + `TouristTrip` (точная туристическая семантика). Общий билдер, чтобы
 * страницы /catalog/tours/[id] и /marketplace/tours/[id] не расходились.
 */

export interface TourSeoInput {
  id: string | number;
  title: string;
  description?: string | null;
  base_price: string | number;
  rating?: string | number | null;
  review_count?: number | null;
  operator_name: string;
  activity_type?: string | null;
  tour_image?: string | null;
  photos?: string[] | null;
  duration_hours?: string | number | null;
  multi_day_count?: number | null;
  location_name?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  /** Месяц начала/конца сезона (1–12) — для Offer.availabilityStarts/Ends. */
  season_start?: number | null;
  season_end?: number | null;
  /** Что входит в тур — для amenityFeature (ответы Алисы «что входит»). */
  included?: string[] | null;
}

export interface TourReviewSeoInput {
  author_name: string;
  author_city?: string | null;
  rating: number;
  comment?: string | null;
  trip_date?: string | Date | null;
}

export interface TourSeoOpts {
  /** Канонический URL страницы тура (для @id, offers.url). */
  canonicalUrl: string;
  /** Базовый URL сайта (для provider.url). */
  siteUrl: string;
  /** Человекочитаемая метка активности (touristType/category). */
  activityLabel: string;
}

function isoDate(d: string | Date): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function buildTourStructuredData(
  tour: TourSeoInput,
  reviews: TourReviewSeoInput[],
  opts: TourSeoOpts,
): Record<string, unknown> {
  const { canonicalUrl, siteUrl, activityLabel } = opts;
  const price = parseFloat(String(tour.base_price));
  const images = tour.tour_image
    ? [tour.tour_image, ...(tour.photos ?? [])]
    : (tour.photos ?? []);
  const hasRating = tour.rating != null && Number(tour.rating) > 0;

  const aggregateRating = hasRating
    ? {
        '@type': 'AggregateRating',
        ratingValue: Number(tour.rating),
        reviewCount: tour.review_count ?? 0,
        bestRating: 5,
        worstRating: 1,
      }
    : undefined;

  const year = new Date().getFullYear();
  const offer = {
    '@type': 'Offer',
    price,
    priceCurrency: 'RUB',
    availability: 'https://schema.org/InStock',
    url: canonicalUrl,
    seller: { '@type': 'Organization', name: tour.operator_name },
    ...(tour.season_start && tour.season_end
      ? {
          availabilityStarts: `${year}-${String(tour.season_start).padStart(2, '0')}-01`,
          availabilityEnds: `${year}-${String(tour.season_end).padStart(2, '0')}-28`,
        }
      : {}),
  };

  const reviewNodes = reviews.slice(0, 5).map((r) => ({
    '@type': 'Review',
    author: {
      '@type': 'Person',
      name: r.author_name,
      ...(r.author_city
        ? { address: { '@type': 'PostalAddress', addressLocality: r.author_city } }
        : {}),
    },
    ...(r.comment ? { reviewBody: r.comment } : {}),
    reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 },
    ...(r.trip_date ? { datePublished: isoDate(r.trip_date) } : {}),
  }));

  // Product — тип, под который Google реально показывает звёзды+цену в выдаче.
  const product: Record<string, unknown> = {
    '@type': 'Product',
    '@id': `${canonicalUrl}#product`,
    name: tour.title,
    ...(tour.description
      ? { description: String(tour.description).replace(/<[^>]+>/g, '').slice(0, 400) }
      : {}),
    ...(images.length ? { image: images } : {}),
    brand: { '@type': 'Organization', name: tour.operator_name },
    ...(activityLabel ? { category: activityLabel } : {}),
    offers: offer,
    ...(aggregateRating ? { aggregateRating } : {}),
    ...(reviewNodes.length ? { review: reviewNodes } : {}),
  };

  // TouristTrip — точная туристическая семантика (сохраняем как было).
  const touristTrip: Record<string, unknown> = {
    '@type': 'TouristTrip',
    '@id': `${canonicalUrl}#trip`,
    name: tour.title,
    ...(tour.description ? { description: String(tour.description) } : {}),
    inLanguage: 'ru',
    ...(activityLabel ? { touristType: activityLabel } : {}),
    keywords: [tour.title, activityLabel, tour.location_name ?? 'Камчатка', 'туры Камчатка', 'Камчатский край']
      .filter(Boolean)
      .join(', '),
    // Speakable — для голосовых ответов Алисы AI
    speakable: {
      '@type': 'SpeakableSpecification',
      cssSelector: ['h1', '.tour-description', 'article p:first-of-type', '[data-speakable]'],
    },
    ...(images.length ? { image: images } : {}),
    ...(tour.multi_day_count
      ? { duration: `P${tour.multi_day_count}D` }
      : tour.duration_hours
        ? { duration: `PT${Math.round(Number(tour.duration_hours))}H` }
        : {}),
    provider: { '@type': 'TouristInformationCenter', name: tour.operator_name, url: siteUrl },
    offers: offer,
    ...(aggregateRating ? { aggregateRating } : {}),
    location: {
      '@type': 'Place',
      name: tour.location_name ?? 'Камчатка',
      address: {
        '@type': 'PostalAddress',
        addressLocality: tour.location_name ?? 'Камчатка',
        addressRegion: 'Камчатский край',
        addressCountry: 'RU',
      },
      ...(tour.latitude && tour.longitude
        ? {
            geo: { '@type': 'GeoCoordinates', latitude: Number(tour.latitude), longitude: Number(tour.longitude) },
            hasMap: `https://maps.yandex.ru/?ll=${tour.longitude},${tour.latitude}&z=12`,
          }
        : {}),
    },
    ...(Array.isArray(tour.included) && tour.included.length > 0
      ? {
          amenityFeature: tour.included.map((item) => ({
            '@type': 'LocationFeatureSpecification',
            name: item,
            value: true,
          })),
        }
      : {}),
  };

  return { '@context': 'https://schema.org', '@graph': [product, touristTrip] };
}
