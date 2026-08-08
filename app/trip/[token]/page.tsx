import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/seo/JsonLd';
import { TripShareClient } from './_TripShareClient';

interface PageProps {
  params: Promise<{ token: string }>;
}

async function fetchTrip(token: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://vedarai.ru';
  try {
    const res = await fetch(`${baseUrl}/api/trips/share/${token}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    return json.success ? json.data : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  const trip = await fetchTrip(token);
  if (!trip) return { title: 'Маршрут' };
  const dateRange = trip.arrival_date && trip.departure_date
    ? ` · ${trip.arrival_date} – ${trip.departure_date}` : '';
  return {
    title: `${trip.title}${dateRange}`,
    description: `Маршрут по Камчатке на ${Array.isArray(trip.days) ? trip.days.length : 0} дней. Открой и создай свой!`,
    openGraph: {
      title: `${trip.title} — маршрут по Камчатке`,
      description: `${Array.isArray(trip.days) ? trip.days.length : 0} дней · vedarai.ru`,
      images: [{ url: '/icons/og-image.jpg', width: 1200, height: 630 }],
    },
  };
}

export default async function TripSharePage({ params }: PageProps) {
  const { token } = await params;
  const trip = await fetchTrip(token);
  if (!trip) notFound();

  // TouristTrip + itinerary по дням: шарящийся план — публичная страница,
  // и поисковикам/AI-ответам нужна её точная семантика, а не голый HTML.
  // item — TouristAttraction с координатами дня (не голое имя): сущность
  // с geo — сильный сигнал места для AI-ответов.
  const days = Array.isArray(trip.days) ? trip.days as Array<{ day: number; title: string; coords?: [number, number] }> : [];
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TouristTrip',
    name: trip.title,
    description: `Маршрут по Камчатке на ${days.length} дней`,
    itinerary: {
      '@type': 'ItemList',
      numberOfItems: days.length,
      itemListElement: days.map((d, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: `День ${d.day}: ${d.title}`,
        item: {
          '@type': 'TouristAttraction',
          name: d.title,
          ...(Array.isArray(d.coords) && d.coords.length === 2
            ? { geo: { '@type': 'GeoCoordinates', latitude: d.coords[0], longitude: d.coords[1] } }
            : {}),
        },
      })),
    },
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <TripShareClient trip={trip} token={token} />
    </>
  );
}
