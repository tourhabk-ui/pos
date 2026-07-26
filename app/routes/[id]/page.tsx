import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import RouteDetailClient from './_RouteDetailClient';
import { CATEGORY_PAGES } from '@/lib/routes/category-meta';
import CategoryPage from '@/components/routes/CategoryPage';
import { query } from '@/lib/database';
import { stripSourceAttribution } from '@/lib/text/source-attribution';
import { isUuid } from '@/lib/text/slugify';

// ISR: реvalidate každый час для свежести контента в Google
export const revalidate = 3600;

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Резолвит slug ИЛИ uuid → uuid. slug живёт на мастер-таблицах (places/
 * kamchatka_routes), а VIEW agent_route_knowledge его не содержит — поэтому
 * сначала находим id по slug, дальше карточка работает как раньше по id.
 */
async function resolveToId(idOrSlug: string): Promise<string | null> {
  if (isUuid(idOrSlug)) return idOrSlug;
  try {
    // VIEW agent_route_knowledge ключуется по ark_id для мест и COALESCE(ark_id,id)
    // для маршрутов (миграция 677) — резолвим slug именно в этот id.
    const r = await query(
      `SELECT ark_id::text AS id FROM places WHERE slug = $1
       UNION ALL SELECT COALESCE(ark_id, id)::text AS id FROM kamchatka_routes WHERE slug = $1
       LIMIT 1`,
      [idOrSlug]
    );
    return (r.rows[0]?.id as string) ?? null;
  } catch {
    return null;
  }
}

async function getRoute(idOrSlug: string) {
  const realId = await resolveToId(idOrSlug);
  if (!realId) return null;
  try {
    const result = await query(
      `SELECT id, category, title, description, lat, lng, source_url, payload,
              location_type, activity_type
       FROM agent_route_knowledge WHERE id = $1 AND is_visible = TRUE`,
      [realId]
    );
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    // slug — из мастер-таблиц (во VIEW его нет). Пришли по slug — знаем сразу.
    let slug: string | null = isUuid(idOrSlug) ? null : idOrSlug;
    if (slug === null) {
      try {
        // realId — это id из VIEW: ark_id для мест, COALESCE(ark_id,id) для маршрутов.
        const s = await query(
          `SELECT slug FROM places WHERE ark_id::text = $1
           UNION ALL SELECT slug FROM kamchatka_routes WHERE COALESCE(ark_id, id)::text = $1
           LIMIT 1`,
          [realId]
        );
        slug = (s.rows[0]?.slug as string | null) ?? null;
      } catch { /* slug необязателен */ }
    }
    const payload = (r.payload as Record<string, unknown>) ?? {};
    return {
      id: r.id as string,
      category: r.category as string,
      title: r.title as string,
      description: stripSourceAttribution((r.description as string | null) ?? ''),
      lat: r.lat != null ? parseFloat(r.lat as string) : null,
      lng: r.lng != null ? parseFloat(r.lng as string) : null,
      sourceUrl: (r.source_url as string | null) ?? null,
      priceFrom: payload.price_from != null ? Number(payload.price_from) : null,
      durationDays: payload.duration_days != null ? Number(payload.duration_days) : null,
      season: (payload.season as string | null) ?? null,
      difficulty: (payload.difficulty as string | null) ?? null,
      bestMonths: Array.isArray(payload.best_months) ? payload.best_months as string[] : null,
      photos: Array.isArray(payload.photos) ? payload.photos as string[] : null,
      locationType: (r.location_type as string | null) ?? null,
      activityType: (r.activity_type as string | null) ?? null,
      slug,
    };
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;

  // Category page metadata
  const catMeta = CATEGORY_PAGES[id];
  if (catMeta) {
    return {
      title: catMeta.title,
      description: catMeta.description,
      keywords: catMeta.keywords,
      alternates: { canonical: `https://vedarai.ru/routes/${id}` },
      openGraph: {
        title: catMeta.title,
        description: catMeta.description,
        url: `https://vedarai.ru/routes/${id}`,
        siteName: 'Ведар',
        locale: 'ru_RU',
        type: 'website',
      },
    };
  }

  // Individual route metadata — id может быть UUID или slug
  const route = await getRoute(id);
  if (!route) return { title: 'Маршрут не найден' };
  // Канонический URL — всегда по slug (если он есть), даже если пришли по UUID
  const canonicalId = route.slug ?? id;

  const title = `${route.title} — маршрут на Камчатке`;
  const desc = route.description
    ? route.description.replace(/<[^>]+>/g, '').slice(0, 180)
    : `Туристический маршрут на Камчатке: ${route.title}. Категория: ${route.category}.`;

  // SEO keywords: города + типы активностей + регион
  const baseKeywords = [
    route.title,
    `${route.title} Камчатка`,
    route.category,
    `${route.category} Камчатка`,
    route.activityType,
    route.locationType,
  ];
  
  // Добавляем релевантные поисковые фразы по категориям
  const categoryKeywords = {
    'вулканы': ['вулканы Камчатки', 'восхождение на вулкан', 'активные вулканы'],
    'медведи': ['медведи Камчатки', 'сафари на медведей', 'наблюдение медведей'],
    'рыбалка': ['рыбалка Камчатка', 'форель Камчатки', 'рыба лосось'],
    'горячие источники': ['горячие источники', 'термальные источники', 'вулканические источники'],
    'вертолёты': ['вертолётные туры', 'полёты на вертолёте', 'авиатуры'],
    'море': ['морские туры', 'круизы', 'рыболовные туры'],
  };
  
  const additionalKeywords = categoryKeywords[route.category as keyof typeof categoryKeywords] ?? [];
  
  const keywords = [
    ...baseKeywords,
    ...additionalKeywords,
    'Камчатка',
    'туры Камчатки',
    'туристические маршруты',
    'путешествия',
  ].filter(Boolean) as string[];

  const images = route.photos?.length
    ? route.photos.slice(0, 1).map(url => ({ url, width: 1200, height: 630, alt: route.title }))
    : [];

  return {
    title,
    description: desc,
    keywords,
    alternates: { canonical: `https://vedarai.ru/routes/${canonicalId}` },
    openGraph: {
      title,
      description: desc,
      url: `https://vedarai.ru/routes/${canonicalId}`,
      siteName: 'Ведар',
      locale: 'ru_RU',
      type: 'article',
      ...(images.length > 0 ? { images } : {}),
    },
  };
}

export default async function RouteOrCategoryPage({ params }: Props) {
  const { id } = await params;

  // ── Category page ──────────────────────────────────────────
  if (CATEGORY_PAGES[id]) {
    const catMeta = CATEGORY_PAGES[id];
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: catMeta.h1,
      description: catMeta.description,
      url: `https://vedarai.ru/routes/${id}`,
      breadcrumb: {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Главная', item: 'https://vedarai.ru' },
          { '@type': 'ListItem', position: 2, name: 'Маршруты', item: 'https://vedarai.ru/routes' },
          { '@type': 'ListItem', position: 3, name: catMeta.name, item: `https://vedarai.ru/routes/${id}` },
        ],
      },
    };
    return (
      <>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <CategoryPage category={id} />
      </>
    );
  }

  // ── Individual route page (id = UUID или slug) ─────────────
  if (!id) notFound();

  const route = await getRoute(id);
  if (!route) notFound();

  // Пришли по UUID, а у объекта есть человекочитаемый slug → 301 на slug
  // (канонический ЧПУ-URL). Так поисковики индексируют один адрес, старые
  // UUID-ссылки продолжают работать через редирект.
  if (isUuid(id) && route.slug && route.slug !== id) {
    permanentRedirect(`/routes/${route.slug}`);
  }

  const cleanDesc = route.description
    ? route.description.replace(/<[^>]+>/g, '').slice(0, 500)
    : undefined;

  // Enhanced JSON-LD для Алисы AI и поисковых систем
  const durationISO = route.durationDays
    ? route.durationDays < 1
      ? 'PT4H' // half day
      : `P${Math.ceil(route.durationDays)}D`
    : undefined;

  // Keywords для голосового поиска Алисы
  const routeKeywords = [
    route.title,
    `${route.title} Камчатка`,
    route.category,
    route.activityType,
    route.locationType,
    'туры Камчатки',
    'Камчатка',
  ].filter(Boolean).join(', ');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TouristTrip',
    '@id': `https://vedarai.ru/routes/${id}`,
    name: route.title,
    description: cleanDesc,
    url: `https://vedarai.ru/routes/${id}`,
    inLanguage: 'ru',
    touristType: route.activityType ?? route.category,
    keywords: routeKeywords,
    // Speakable — для голосовых ответов Алисы AI
    speakable: {
      '@type': 'SpeakableSpecification',
      cssSelector: ['h1', '.route-description', 'article p:first-of-type', '[data-speakable]'],
    },
    // About — объект путешествия как туристическая достопримечательность
    about: {
      '@type': 'TouristAttraction',
      name: route.title,
      description: cleanDesc,
      address: {
        '@type': 'PostalAddress',
        addressRegion: 'Камчатский край',
        addressCountry: 'RU',
      },
    },
    // Multiple images for better indexing (up to 5)
    ...(route.photos?.length
      ? { image: route.photos.slice(0, 5).map(url => ({
          '@type': 'ImageObject',
          url,
          name: route.title,
        })) }
      : {}),
    // Duration in ISO 8601 format
    ...(durationISO ? { duration: durationISO } : {}),
    // Location details
    ...(route.lat != null && route.lng != null ? {
      geo: {
        '@type': 'GeoCoordinates',
        latitude: route.lat,
        longitude: route.lng,
        address: `${route.title}, Камчатский край, Россия`,
      },
      hasMap: `https://maps.yandex.ru/?ll=${route.lng},${route.lat}&z=12`,
      contentLocation: {
        '@type': 'Place',
        name: 'Камчатский край',
        geo: {
          '@type': 'GeoCoordinates',
          latitude: 52.9306,
          longitude: 160.7837,
        },
        address: {
          '@type': 'PostalAddress',
          addressRegion: 'Камчатский край',
          addressCountry: 'RU',
        },
      },
    } : {}),
    // Pricing
    ...(route.priceFrom != null ? {
      offers: {
        '@type': 'Offer',
        price: route.priceFrom,
        priceCurrency: 'RUB',
        availability: 'https://schema.org/InStock',
        url: `https://vedarai.ru/routes/${id}`,
        seller: {
          '@type': 'TravelAgency',
          name: 'Ведар',
          url: 'https://vedarai.ru',
        },
      },
    } : {}),
    // Difficulty level
    ...(route.difficulty ? {
      accessibilityFeature: route.difficulty === 'easy'
        ? ['lowPhysicalRequirements']
        : route.difficulty === 'hard' || route.difficulty === 'extreme'
          ? ['highPhysicalRequirements']
          : ['moderatePhysicalRequirements'],
    } : {}),
    // Best months for visiting (availability window)
    ...(route.bestMonths && route.bestMonths.length > 0 ? {
      seasonalEvent: route.bestMonths.map((m) => {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const idx = typeof m === 'number' ? m - 1 : 0;
        return months[Math.max(0, Math.min(11, idx))];
      }).join(', '),
    } : {}),
    provider: {
      '@type': 'TravelAgency',
      name: 'Ведар',
      url: 'https://vedarai.ru',
      sameAs: ['https://vedarai.ru', 'https://t.me/kamchatourhub'],
    },
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная', item: 'https://vedarai.ru' },
      { '@type': 'ListItem', position: 2, name: 'Маршруты', item: 'https://vedarai.ru/routes' },
      { '@type': 'ListItem', position: 3, name: route.title, item: `https://vedarai.ru/routes/${id}` },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      <RouteDetailClient id={route.id} />
    </>
  );
}
