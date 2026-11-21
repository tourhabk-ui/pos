/** Хаб «восхождения на вулканы Камчатки» (Сыщик, 21.11; lib/landings). Сезоны туров — из базы. */
import { LandingPage, landingPageMetadata } from '@/components/landings/LandingPage';
import { landingBySlug } from '@/lib/landings/landings';

export const dynamic = 'force-dynamic';

const SLUG = 'voshozhdeniya-na-vulkany-kamchatki';

export function generateMetadata() {
  return landingPageMetadata(landingBySlug(SLUG));
}

export default function Page() {
  return <LandingPage slug={SLUG} />;
}
