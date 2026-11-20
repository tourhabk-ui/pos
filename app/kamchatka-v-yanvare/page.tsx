/** Посадочная «камчатка в январе» (Сыщик, 20.11; lib/landings). */
import { LandingPage, landingPageMetadata } from '@/components/landings/LandingPage';
import { landingBySlug } from '@/lib/landings/landings';

export const dynamic = 'force-dynamic';

const SLUG = 'kamchatka-v-yanvare';

export function generateMetadata() {
  return landingPageMetadata(landingBySlug(SLUG));
}

export default function Page() {
  return <LandingPage slug={SLUG} />;
}
