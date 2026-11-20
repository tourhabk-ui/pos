/**
 * «Когда ехать на Камчатку» — по месяцам: сколько туров идёт по данным
 * операторов, какие виды и какая рыба в сезоне по справочнику (разбор
 * видимости в ответах ИИ, 19.11).
 */
import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { WhenToGoView } from '@/components/seo/TripFactsPages';
import { loadTripCost } from '@/lib/seo/trip-cost-data';
import { fishByMonth } from '@/lib/seo/trip-cost';
import { FISH_SPECIES } from '@/lib/fish-species';
import { defaultOgImages } from '@/lib/seo/og-image';
import { MonthsNav } from '@/components/landings/LandingContent';
import { pageContainer } from '@/lib/layout/page-width';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const PATH = '/kogda-ehat-na-kamchatku';
const TITLE = 'Когда ехать на Камчатку: туры и рыба по месяцам';
const DESCRIPTION = 'В каком месяце ехать на Камчатку: сколько туров идёт в каждый месяц по данным операторов, какие виды и какая рыба в сезоне. Из базы Ведара на сегодня.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: `${SITE}${PATH}` },
  openGraph: { url: `${SITE}${PATH}`, title: TITLE, description: DESCRIPTION, images: defaultOgImages(), type: 'website', siteName: 'Ведар', locale: 'ru_RU' },
  robots: { index: true, follow: true },
};

export default async function Page() {
  const { tours } = await loadTripCost();
  return (
    <>
      <Header />
      <WhenToGoView tours={tours} fish={fishByMonth(FISH_SPECIES)} />
      {/* Хаб месячных страниц (Сыщик, 20.11): каждая ссылается сюда и на соседей. */}
      <div className={`${pageContainer('reading')} pb-10`}>
        <MonthsNav current="/kogda-ehat-na-kamchatku" />
      </div>
    </>
  );
}
