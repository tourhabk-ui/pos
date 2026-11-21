/** Посадочная Сыщика, четвёртая партия (21.11; lib/landings/texts-batch4.ts). Туры и даты — из базы. */
import { LandingPage, landingPageMetadata } from '@/components/landings/LandingPage';
import { landingBySlug } from '@/lib/landings/landings';

export const dynamic = 'force-dynamic';

const SLUG = 'vachkazhets-kak-dobratsya';

export function generateMetadata() {
  return landingPageMetadata(landingBySlug(SLUG));
}

export default function Page() {
  return <LandingPage slug={SLUG} />;
}
