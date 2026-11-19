/**
 * «Сколько стоит поездка на Камчатку» — цены туров по видам, жилья и машины
 * под заказ из базы (разбор видимости в ответах ИИ, 19.11). Сумм «за неделю»
 * нет: состав у каждого свой — смету считает планер.
 */
import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import { TripCostView } from '@/components/seo/TripFactsPages';
import { loadTripCost } from '@/lib/seo/trip-cost-data';
import { defaultOgImages } from '@/lib/seo/og-image';
import { plural } from '@/lib/home/data-freshness';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const PATH = '/skolko-stoit-poezdka-na-kamchatku';

export async function generateMetadata(): Promise<Metadata> {
  const { tours } = await loadTripCost();
  const n = tours?.length ?? 0;
  const title = n > 0
    ? `Сколько стоит поездка на Камчатку: цены ${n} ${plural(n, 'тура', 'туров', 'туров')}, жильё, трансфер`
    : 'Сколько стоит поездка на Камчатку: туры, жильё, трансфер';
  const description = 'Цены туров на Камчатку по видам, жилья за ночь и машины под заказ — из базы Ведара на сегодня, с единицей цены. Без выдуманных вилок «за неделю».';
  return {
    title: { absolute: title.length <= 65 ? title : 'Сколько стоит поездка на Камчатку: туры, жильё, трансфер' },
    description,
    alternates: { canonical: `${SITE}${PATH}` },
    openGraph: { url: `${SITE}${PATH}`, title, description, images: defaultOgImages(), type: 'website', siteName: 'Ведар', locale: 'ru_RU' },
    robots: { index: true, follow: true },
  };
}

export default async function Page() {
  const data = await loadTripCost();
  return (
    <>
      <Header />
      <TripCostView data={data} />
    </>
  );
}
