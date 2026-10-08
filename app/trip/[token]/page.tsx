import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/seo/JsonLd';
import { TripShareClient, type Trip } from './_TripShareClient';
import { defaultOgImages } from '@/lib/seo/og-image';

interface PageProps {
  params: Promise<{ token: string }>;
}

type TripRead =
  | { kind: 'found'; trip: Trip }
  | { kind: 'missing' }
  | { kind: 'failed' };

/**
 * Три исхода, как у share-API (§4.0): план есть; плана нет (404); прочитать
 * не смогли (503, сеть). Третий — не «не найдено»: черновик Кузьмича лежит на
 * месте, и отправлять человека собирать его заново — враньё (#2225).
 */
async function fetchTrip(token: string): Promise<TripRead> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://vedarai.ru';
  try {
    const res = await fetch(`${baseUrl}/api/trips/share/${token}`, { cache: 'no-store' });
    if (res.status === 404 || res.status === 400) return { kind: 'missing' };
    if (!res.ok) return { kind: 'failed' };
    const json = await res.json();
    return json.success && json.data ? { kind: 'found', trip: json.data } : { kind: 'failed' };
  } catch (err) {
    console.error('[trip/page] план не получен:', err instanceof Error ? err.message.slice(0, 200) : 'неизвестная ошибка');
    return { kind: 'failed' };
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  const read = await fetchTrip(token);
  if (read.kind !== 'found') return { title: 'Маршрут', robots: { index: false } };
  const trip = read.trip;
  // Черновик Кузьмича/MCP — личный и живёт 7 дней: в индексе ему не место,
  // ссылку получает тот, кому её дали (#2225).
  if (trip.source === 'draft') {
    return {
      title: trip.title,
      description: `План поездки по Камчатке на ${Array.isArray(trip.days) ? trip.days.length : 0} дн.: карта, GPX, сохранение для офлайна.`,
      robots: { index: false, follow: false },
    };
  }
  const dateRange = trip.arrival_date && trip.departure_date
    ? ` · ${trip.arrival_date} – ${trip.departure_date}` : '';
  return {
    title: `${trip.title}${dateRange}`,
    description: `Маршрут по Камчатке на ${Array.isArray(trip.days) ? trip.days.length : 0} дней. Открой и создай свой!`,
    openGraph: {
      title: `${trip.title} — маршрут по Камчатке`,
      description: `${Array.isArray(trip.days) ? trip.days.length : 0} дней · vedarai.ru`,
      images: defaultOgImages(),
    },
  };
}

export default async function TripSharePage({ params }: PageProps) {
  const { token } = await params;
  const read = await fetchTrip(token);
  if (read.kind === 'missing') notFound();
  // Не смогли прочитать — ошибка, а не «не найдено»: граница ошибки скажет
  // «попробуйте позже», а сохранённая для офлайна копия у service worker'а
  // от этого не пострадает.
  if (read.kind === 'failed') throw new Error('План поездки сейчас не прочитался');
  const trip = read.trip;

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
      {trip.source !== 'draft' && <JsonLd data={jsonLd} />}
      <TripShareClient trip={trip} token={token} />
    </>
  );
}
