/** Посадочная под запрос «堪察加 旅游 预订» — lib/seo/query-landings (zh-booking). */
import { headers } from 'next/headers';
import { Header } from '@/components/layout/Header';
import { QueryLandingView } from '@/components/seo/QueryLanding';
import { recordZhEntryHit } from '@/lib/analytics/agent-entry-hits';
import { landingByKey } from '@/lib/seo/query-landings';
import { landingMetadata } from '@/lib/seo/query-landing-meta';
import { loadLandingTours } from '@/lib/seo/query-landings-data';
import { loadLandingParks } from '@/lib/seo/query-landings-parks';

export const dynamic = 'force-dynamic';

const LANDING = landingByKey('zh-booking');

export const metadata = landingMetadata(LANDING);

export default async function Page() {
  // Layout не пишет сырой UA на /zh: иначе визит посчитался бы дважды там,
  // где страница зовёт recordZhEntryHit сама. Эта посадочная — тоже /zh.
  recordZhEntryHit('/zh/booking', (await headers()).get('user-agent'));
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
