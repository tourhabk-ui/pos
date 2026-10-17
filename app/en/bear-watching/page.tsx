/** Посадочная под запрос «Kamchatka bear watching tour» — lib/seo/query-landings (en-bears). */
import { Header } from '@/components/layout/Header';
import { QueryLandingView } from '@/components/seo/QueryLanding';
import { landingByKey } from '@/lib/seo/query-landings';
import { landingMetadata } from '@/lib/seo/query-landing-meta';
import { loadLandingTours } from '@/lib/seo/query-landings-data';
import { loadLandingParks } from '@/lib/seo/query-landings-parks';

export const dynamic = 'force-dynamic';

const LANDING = landingByKey('en-bears');

export const metadata = landingMetadata(LANDING);

export default async function Page() {
  const [tours, parks] = await Promise.all([
    loadLandingTours(LANDING.topic, LANDING.lang === 'zh-CN'),
    loadLandingParks(LANDING.topic),
  ]);
  return (
    <>
      <Header />
      <QueryLandingView landing={LANDING} tours={tours} parks={parks} />
    </>
  );
}
