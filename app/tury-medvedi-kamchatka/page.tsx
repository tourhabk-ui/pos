/** Посадочная под запрос «Камчатка медведи тур» — lib/seo/query-landings (ru-bears). */
import { Header } from '@/components/layout/Header';
import { QueryLandingView } from '@/components/seo/QueryLanding';
import { landingByKey } from '@/lib/seo/query-landings';
import { landingMetadata } from '@/lib/seo/query-landing-meta';
import { loadLandingPage } from '@/lib/seo/query-landings-data';
import { landingSummary } from '@/lib/seo/query-landing-view';
import { loadLandingParks } from '@/lib/seo/query-landings-parks';

export const dynamic = 'force-dynamic';

const LANDING = landingByKey('ru-bears');

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
      <QueryLandingView landing={LANDING} tours={tours} parks={parks} summary={landingSummary(tours, openYears)} />
    </>
  );
}
