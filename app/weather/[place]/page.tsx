import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import { WeatherView } from '@/components/weather/WeatherView';
import { loadWeatherPage } from '@/lib/weather/weather-page';
import { DEFAULT_WEATHER_SLUG, weatherPlaceBySlug, weatherPlaceHref } from '@/lib/weather/places';
import { defaultOgImages } from '@/lib/seo/og-image';

/**
 * Погода одного места — `/weather/<slug>`. Список мест закрытый
 * (lib/weather/places.ts): чужой slug — 404, а не запрос к Open-Meteo по
 * выдуманному имени. Город живёт на самой /weather, его slug ведёт туда.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ place: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { place: slug } = await params;
  const place = weatherPlaceBySlug(slug);
  if (!place) return { title: 'Погода на Камчатке', robots: { index: false } };
  const url = `https://vedarai.ru${weatherPlaceHref(place)}`;
  const title = `Погода ${place.where} — прогноз на 7 дней`;
  const description = `Прогноз погоды ${place.where} на неделю: температура, осадки по частям дня, ветер. Предупреждения Росгидромета по Камчатке.`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { images: defaultOgImages(), title, description, url, siteName: 'Ведар', locale: 'ru_RU', type: 'website' },
  };
}

export default async function WeatherPlacePage({ params }: PageProps) {
  const { place: slug } = await params;
  if (slug === DEFAULT_WEATHER_SLUG) permanentRedirect('/weather');
  const data = await loadWeatherPage(slug);
  if (!data) notFound();
  return (
    <>
      <Header />
      <main className="ds-page px-4 pt-20 pb-24">
        <WeatherView data={data} />
      </main>
      <BottomNav activePath="/weather" />
    </>
  );
}
