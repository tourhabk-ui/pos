/** Посадочная «сколько дней нужно на камчатку» (Сыщик, третья партия 21.11; lib/landings). */
import { LandingPage, landingPageMetadata } from '@/components/landings/LandingPage';
import { landingBySlug } from '@/lib/landings/landings';

export const dynamic = 'force-dynamic';

const SLUG = 'skolko-dnej-nuzhno-na-kamchatku';

export function generateMetadata() {
  return landingPageMetadata(landingBySlug(SLUG));
}

export default function Page() {
  return <LandingPage slug={SLUG} />;
}
