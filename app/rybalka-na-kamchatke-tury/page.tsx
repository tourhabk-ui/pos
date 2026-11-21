/**
 * Посадочная под запрос «рыбалка на Камчатке туры» — lib/seo/query-landings (ru-fishing).
 * Над витриной — гид Сыщика «где и когда ловить» (хаб 21.11, lib/landings/texts-hubs);
 * H1 и заголовок страницы прежние, разметка FAQPage — одна, у витрины.
 */
import { Header } from '@/components/layout/Header';
import { QueryLandingView } from '@/components/seo/QueryLanding';
import { landingByKey } from '@/lib/seo/query-landings';
import { landingMetadata } from '@/lib/seo/query-landing-meta';
import { loadLandingPage } from '@/lib/seo/query-landings-data';
import { landingSummary } from '@/lib/seo/query-landing-view';
import { loadLandingParks } from '@/lib/seo/query-landings-parks';
import { LandingContent } from '@/components/landings/LandingContent';
import { landingBySlug } from '@/lib/landings/landings';
import { JsonLd } from '@/components/seo/JsonLd';
import { articleJsonLd } from '@/lib/articles/article-jsonld';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const dynamic = 'force-dynamic';

const LANDING = landingByKey('ru-fishing');
const GUIDE = landingBySlug('rybalka-na-kamchatke-gde-i-kogda-lovit');

// Заголовок и описание — с числами из базы (разбор видимости в ответах ИИ, 19.11).
export async function generateMetadata() {
  const { tours, openYears } = await loadLandingPage(LANDING);
  return landingMetadata(LANDING, undefined, landingSummary(tours, openYears));
}

export default async function Page() {
  const [{ tours, openYears }, parks] = await Promise.all([
    loadLandingPage(LANDING),
    loadLandingParks(LANDING.topic),
  ]);
  const url = `${SITE}${LANDING.path}`;
  return (
    <>
      {/* Гид над витриной — длинный текст: Article (повторный аудит Сыщика 21.11).
          FAQPage остаётся одна — у витрины, поэтому здесь faq пустой. */}
      <JsonLd data={articleJsonLd({ url, site: SITE, headline: LANDING.h1, description: GUIDE.description, datePublished: GUIDE.date, dateModified: GUIDE.date, faq: [] })} />
      <JsonLd data={{
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Главная', item: SITE },
          { '@type': 'ListItem', position: 2, name: LANDING.h1, item: url },
        ],
      }} />
      <Header />
      <QueryLandingView landing={LANDING} tours={tours} parks={parks} summary={landingSummary(tours, openYears)}
        guide={<LandingContent landing={GUIDE} tours={null} showH1={false} withJsonLd={false} />}
      />
    </>
  );
}
