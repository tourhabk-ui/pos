import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import { WeatherView } from '@/components/weather/WeatherView';
import { loadWeatherPage } from '@/lib/weather/weather-page';
import { DEFAULT_WEATHER_SLUG } from '@/lib/weather/places';
import { defaultOgImages } from '@/lib/seo/og-image';

/**
 * Погода на Камчатке — страница края (решение владельца 08.10). Данные и
 * источники — lib/weather/weather-page.ts, места — lib/weather/places.ts.
 *
 * Рендер на каждый запрос, как у /svodka: пререндер при сборке шёл бы без
 * базы, и первый посетитель после деплоя получил бы «не удалось» у мест из
 * каталога и у предупреждений. Open-Meteo на каждый заход не дёргается — у
 * fetchForecastDays свой кэш на три часа.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Погода на Камчатке — прогноз на 7 дней по местам',
  description:
    'Прогноз погоды на Камчатке на неделю: Петропавловск-Камчатский, Авачинский и Мутновский вулканы, Налычево, Эссо, Ключи. Осадки по частям дня, ветер, предупреждения Росгидромета.',
  alternates: { canonical: 'https://vedarai.ru/weather' },
  openGraph: {
    images: defaultOgImages(),
    title: 'Погода на Камчатке — прогноз на 7 дней',
    description: 'Прогноз по местам маршрутов: осадки по частям дня, ветер, предупреждения Росгидромета.',
    url: 'https://vedarai.ru/weather',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

export default async function WeatherPage() {
  const data = await loadWeatherPage(DEFAULT_WEATHER_SLUG);
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
