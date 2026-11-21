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
  return (
    <>
      <Header />
      <QueryLandingView landing={LANDING} tours={tours} parks={parks} summary={landingSummary(tours, openYears)}
        guide={<LandingContent landing={GUIDE} tours={null} showH1={false} withJsonLd={false} />}
      />
    </>
  );
}
